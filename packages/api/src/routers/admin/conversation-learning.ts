import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  ConversationLearningActionError,
  getConversationLearningPolicy,
  updateConversationLearningPolicy,
  listConversationLearningCandidates,
  reviewConversationLearningCandidate,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const scope = { tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) }
const policy = z.enum(['VISITOR_AND_EMPLOYEE', 'EMPLOYEE_ONLY', 'DISABLED'])

async function learningAction<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof ConversationLearningActionError)
      throw new TRPCError({
        code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
        message: error.message,
      })
    throw error
  }
}

export const adminConversationLearningRouter = router({
  getConversationLearningPolicy: adminProcedure
    .input(z.object(scope).strict())
    .query(({ input }) => learningAction(() => getConversationLearningPolicy(input))),
  updateConversationLearningPolicy: adminProcedure
    .input(
      z
        .object({
          ...scope,
          operationId: z.string().uuid(),
          policy,
          expectedUpdatedAt: z.coerce.date(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      learningAction(() =>
        updateConversationLearningPolicy({
          ...input,
          actor: { type: 'PLATFORM_ADMIN', id: ctx.session.userId },
        }),
      ),
    ),
  listConversationLearningCandidates: adminProcedure
    .input(
      z
        .object({
          ...scope,
          reviewStatus: z.enum(['UNREVIEWED', 'ACKNOWLEDGED', 'DISMISSED']).optional(),
          limit: z.number().int().min(1).max(100).default(50),
        })
        .strict(),
    )
    .query(({ input }) =>
      learningAction(() =>
        listConversationLearningCandidates({
          tenantId: input.tenantId,
          venueId: input.venueId,
          limit: input.limit,
          ...(input.reviewStatus ? { reviewStatus: input.reviewStatus } : {}),
        }),
      ),
    ),
  reviewConversationLearningCandidate: adminProcedure
    .input(
      z
        .object({
          ...scope,
          operationId: z.string().uuid(),
          insightId: z.string().uuid(),
          expectedRevision: z.number().int().nonnegative(),
          action: z.enum(['EDIT', 'ACCEPT_FOR_PROPOSAL', 'REJECT']),
          summary: z.string().trim().min(1).max(1000).optional(),
          reviewerFeedback: z.string().trim().min(1).max(1000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      learningAction(() =>
        reviewConversationLearningCandidate({
          tenantId: input.tenantId,
          venueId: input.venueId,
          operationId: input.operationId,
          insightId: input.insightId,
          expectedRevision: input.expectedRevision,
          action: input.action,
          reviewerFeedback: input.reviewerFeedback,
          ...(input.summary ? { summary: input.summary } : {}),
          actor: { type: 'PLATFORM_ADMIN', id: ctx.session.userId },
        }),
      ),
    ),
})
