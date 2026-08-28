import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import {
  createInterviewClarificationQuestions,
  InterviewClarificationError,
} from '../../lib/intake-interview-clarifications'
import { adminProcedure } from '../../trpc'

export const adminIntakeInterviewClarificationsRouter = router({
  createInterviewClarificationQuestions: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          runId: z.string().trim().min(1).max(191),
          expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          clarificationIds: z.array(z.string().trim().min(1).max(191)).min(1).max(20),
          agentIdentityId: z.string().trim().min(1).max(191),
        })
        .strict()
        .superRefine((value, context) => {
          if (new Set(value.clarificationIds).size !== value.clarificationIds.length) {
            context.addIssue({
              code: 'custom',
              path: ['clarificationIds'],
              message: 'Clarification selections must be unique.',
            })
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createInterviewClarificationQuestions({ db: ctx.db, ...input })
      } catch (error) {
        if (error instanceof InterviewClarificationError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : error.code === 'INVALID_INPUT'
                    ? 'BAD_REQUEST'
                    : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),
})
