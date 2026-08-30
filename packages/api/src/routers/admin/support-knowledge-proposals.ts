import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  prepareSupportKnowledgeProposalAction,
  publishOperationalEvent,
  SupportKnowledgeProposalActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

export const adminSupportCorrectionProposalsRouter = router({
  listSupportKnowledgeProposals: adminProcedure
    .input(
      z
        .object({
          ...scope,
          supportRequestId: z.string().min(1).max(191),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.knowledgeChangeProposal.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            supportRequestId: input.supportRequestId,
          },
          orderBy: [{ supportRequestVersion: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: {
            id: true,
            status: true,
            supportRequestId: true,
            supportRequestVersion: true,
            proposedChange: true,
            reason: true,
            evidenceMessageIds: true,
            createdByType: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
      ),
    ),

  createSupportKnowledgeProposal: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          ...scope,
          supportRequestId: z.string().min(1).max(191),
          expectedVersion: z.number().int().positive(),
          evidenceMessageIds: z
            .array(z.string().min(1).max(191))
            .min(1)
            .max(20)
            .refine((ids) => new Set(ids).size === ids.length, 'Evidence messages must be unique.'),
          targetKnowledgeEntryId: z.string().min(1).max(191).optional(),
          correctionKind: z.enum([
            'CREATE_KNOWLEDGE',
            'UPDATE_KNOWLEDGE',
            'RETIRE_KNOWLEDGE',
            'RETRIEVAL_CORRECTION',
            'NO_CONTENT_CHANGE',
          ]),
          proposedChange: z.string().trim().min(1).max(10000),
          reason: z.string().trim().min(1).max(2000),
          confidence: z.number().min(0).max(1),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const result = await prepareSupportKnowledgeProposalAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                actorId: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          if (!result.replayed) {
            await publishOperationalEvent({
              client: db,
              event: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                eventType: 'knowledge.proposal.created',
                sourceSubsystem: 'support-operations',
                severity: 'WARNING',
                title: 'Client correction proposal needs review',
                summary:
                  'A reviewed support request produced an evidence-linked proposal. Canonical venue knowledge is unchanged.',
                actionRequired: true,
                linkedObjectType: 'knowledge-change-proposal',
                linkedObjectId: result.proposal.id,
                recommendedAction:
                  'Compare the frozen support evidence with trusted venue sources, then approve or reject the proposal.',
                deduplicationKey: `knowledge-proposal:${result.proposal.id}`,
              },
            }).catch(() => undefined)
          }
          return {
            ...result.proposal,
            replayed: result.replayed,
            canonicalKnowledgeChanged: false as const,
          }
        } catch (error) {
          if (error instanceof SupportKnowledgeProposalActionError) {
            throw new TRPCError({
              code:
                error.code === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : error.code === 'CONFLICT'
                    ? 'CONFLICT'
                    : 'BAD_REQUEST',
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),
})
