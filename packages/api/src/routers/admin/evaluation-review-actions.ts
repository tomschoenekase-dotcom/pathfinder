import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  appendEvaluationReviewAction,
  EvaluationReviewActionError,
  requestEvaluationRunCancellation,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminEvaluationReviewActionsRouter = router({
  appendEvaluationConclusion: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        runId: z.string().uuid(),
        expectedRunIdentityHash: z.string().regex(/^[0-9a-f]{64}$/u),
        resultId: z.string().uuid(),
        expectedRevision: z.number().int().min(0),
        operationId: z.string().uuid(),
        decision: z.enum(['ACCEPTED', 'REJECTED', 'NEEDS_FOLLOW_UP']),
        conclusion: z.string().trim().min(1).max(1000),
        rubricVersion: z
          .string()
          .trim()
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        const review = await withTenantIsolationBypass(() =>
          appendEvaluationReviewAction({
            ...input,
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          }),
        )
        return {
          id: review.id,
          resultId: review.resultId,
          reviewerId: review.reviewerId,
          conclusion: review.conclusion,
          decision: review.decision,
          rubricVersion: review.rubricVersion,
          revision: review.revision,
          createdAt: review.createdAt,
          replayed: review.replayed,
          result: {
            runId: review.result.runId,
            caseRevision: review.result.caseRevision,
            evalCase: review.result.evalCase,
          },
        }
      } catch (error) {
        if (error instanceof EvaluationReviewActionError)
          throw new TRPCError({
            code:
              error.code === 'INVALID_INPUT'
                ? 'BAD_REQUEST'
                : error.code === 'NOT_FOUND'
                  ? 'NOT_FOUND'
                  : 'CONFLICT',
            message: error.message,
          })
        throw error
      }
    }),

  cancelEvaluationRun: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        runId: z.string().uuid(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const outcome = await requestEvaluationRunCancellation({
        ...input,
        requestedBy: ctx.session.userId,
        requestedByRole: 'PLATFORM_ADMIN',
      })
      if (outcome === 'not-found')
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Evaluation run was not found',
        })
      if (outcome === 'terminal')
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A terminal evaluation run cannot be cancelled',
        })
      return { cancellationRequested: true, replayed: outcome === 'already-requested' }
    }),
})
