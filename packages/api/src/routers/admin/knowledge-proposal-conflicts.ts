import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { AgentQuestionActionError, askAgentQuestionAction } from '@pathfinder/db'

import { router } from '../../core'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueConflictQuestionOperationId,
  SemanticVenueUpdaterError,
} from '../../lib/semantic-venue-updater-service'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

export const adminKnowledgeProposalConflictRouter = router({
  createSemanticConflictQuestion: adminProcedure
    .input(
      z
        .object({
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          expectedPreviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          relation: z.enum(['NEW_FACT', 'CORRECTS', 'SUPERSEDES']),
          desired: SemanticUpdaterDesiredKnowledge,
          validFrom: z.string().datetime().optional(),
          validUntil: z.string().datetime().optional(),
          operationalUpdateType: z
            .enum([
              'GENERAL_NOTICE',
              'TEMPORARY_CLOSURE',
              'UNAVAILABLE_EXHIBIT',
              'CHANGED_HOURS',
              'MAINTENANCE',
              'SPECIAL_EVENT',
              'SOLD_OUT_ACTIVITY',
              'TEMPORARY_VENDOR_LOCATION',
            ])
            .optional(),
          agentIdentityId: z.string().trim().min(1).max(191),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const previewInput = {
        tenantId: input.tenantId,
        venueId: input.venueId,
        proposalId: input.proposalId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        relation: input.relation,
        desired: input.desired,
        ...(input.validFrom ? { validFrom: input.validFrom } : {}),
        ...(input.validUntil ? { validUntil: input.validUntil } : {}),
        ...(input.operationalUpdateType
          ? { operationalUpdateType: input.operationalUpdateType }
          : {}),
      }
      let preview
      try {
        preview = await previewSemanticVenueUpdateFromProposal({ db: ctx.db, ...previewInput })
      } catch (error) {
        if (error instanceof SemanticVenueUpdaterError) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
      if (preview.previewHash !== input.expectedPreviewHash) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Semantic preview changed; recompute it before creating a blocking question.',
        })
      }
      const question = preview.questions[0]
      if (preview.classification !== 'CONFLICT' || !question || preview.questions.length !== 1) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Only one exact blocking semantic conflict question can be persisted.',
        })
      }
      const identity = await ctx.db.agentIdentity.findFirst({
        where: {
          id: input.agentIdentityId,
          tenantId: input.tenantId,
          enabled: true,
          agentType: 'CONTENT',
          accessCapabilities: { has: 'content.draft' },
          OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Choose an enabled in-scope Content identity with draft capability.',
        })
      }
      try {
        const created = await askAgentQuestionAction(
          {
            operationId: semanticVenueConflictQuestionOperationId({
              tenantId: input.tenantId,
              venueId: input.venueId,
              proposalId: input.proposalId,
              previewHash: preview.previewHash,
            }),
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: identity.id,
            question: question.prompt,
            context: `Knowledge proposal ${input.proposalId}; semantic preview ${preview.previewHash}; blockers: ${preview.blockers.map((blocker) => `${blocker.code}: ${blocker.message}`).join(' | ')}`,
            questionType: 'LONG_TEXT',
            category: 'semantic-update-conflict',
            urgency: 'HIGH',
            evidence: preview.evidenceRefs.map((reference) => ({
              label: 'Semantic source evidence',
              reference,
            })),
            callbackMetadata: {
              workflow: 'semantic-venue-update',
              proposalId: input.proposalId,
              previewHash: preview.previewHash,
              classification: preview.classification,
              blockerCodes: question.blockerCodes.join(','),
            },
            blocking: true,
          },
          ctx.db,
        )
        return {
          questionId: created.question.id,
          questionStatus: created.question.status,
          replayed: created.replayed,
          previewHash: preview.previewHash,
          executionTriggered: false as const,
          approvalGranted: false as const,
          canonicalKnowledgeChanged: false as const,
        }
      } catch (error) {
        if (error instanceof AgentQuestionActionError) {
          throw new TRPCError({
            code:
              error.code === 'INVALID_INPUT'
                ? 'BAD_REQUEST'
                : error.code === 'FORBIDDEN'
                  ? 'PRECONDITION_FAILED'
                  : error.code,
            message: error.message,
          })
        }
        throw error
      }
    }),
})
