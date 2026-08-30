import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { SemanticUpdaterDesiredKnowledge } from '../../lib/semantic-venue-updater'
import {
  previewSemanticVenueUpdateFromProposal,
  semanticVenueConflictQuestionOperationId,
  SemanticVenueUpdaterError,
} from '../../lib/semantic-venue-updater-service'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) } as const

export const adminKnowledgeProposalPreviewRouter = router({
  previewSemanticVenueUpdate: adminProcedure
    .input(
      z
        .object({
          ...scope,
          proposalId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
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
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        const preview = await previewSemanticVenueUpdateFromProposal({ db: ctx.db, ...input })
        if (preview.classification !== 'CONFLICT' || preview.questions.length !== 1) {
          return { ...preview, conflictQuestion: null, questionAgentIdentities: [] }
        }
        const operationId = semanticVenueConflictQuestionOperationId({
          tenantId: input.tenantId,
          venueId: input.venueId,
          proposalId: input.proposalId,
          previewHash: preview.previewHash,
        })
        const [conflictQuestion, questionAgentIdentities] = await Promise.all([
          ctx.db.agentQuestion.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              operationId,
            },
            select: {
              id: true,
              agentIdentityId: true,
              status: true,
              answer: true,
              answeredAt: true,
              updatedAt: true,
            },
          }),
          ctx.db.agentIdentity.findMany({
            where: {
              tenantId: input.tenantId,
              enabled: true,
              agentType: 'CONTENT',
              accessCapabilities: { has: 'content.draft' },
              OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
            },
            orderBy: [{ identityKey: 'asc' }, { id: 'asc' }],
            take: 20,
            select: { id: true, identityKey: true, name: true },
          }),
        ])
        return { ...preview, conflictQuestion, questionAgentIdentities }
      } catch (error) {
        if (error instanceof SemanticVenueUpdaterError) {
          throw new TRPCError({
            code: error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),
})
