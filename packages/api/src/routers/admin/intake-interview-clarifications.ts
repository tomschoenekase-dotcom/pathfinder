import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import {
  createInterviewClarificationQuestions,
  InterviewClarificationError,
  resolveInterviewClarification,
} from '../../lib/intake-interview-clarifications'
import { adminProcedure } from '../../trpc'

export const adminIntakeInterviewClarificationsRouter = router({
  resolveInterviewClarification: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          runId: z.string().trim().min(1).max(191),
          requestId: z.string().uuid(),
          expectedReviewHash: z.string().regex(/^[a-f0-9]{64}$/u),
          clarificationId: z.string().trim().min(1).max(191),
          expectedAnsweredAt: z.date(),
          kind: z.enum(['REPLACE_PUBLIC_TEXT', 'EXCLUDE_FIELD']),
          amendedPublicText: z.string().trim().min(1).max(2_000).optional(),
          rationale: z.string().trim().min(1).max(500),
        })
        .strict()
        .superRefine((value, context) => {
          if (value.kind === 'REPLACE_PUBLIC_TEXT' && !value.amendedPublicText) {
            context.addIssue({
              code: 'custom',
              path: ['amendedPublicText'],
              message: 'Replacement resolution requires amended public text.',
            })
          }
          if (value.kind === 'EXCLUDE_FIELD' && value.amendedPublicText !== undefined) {
            context.addIssue({
              code: 'custom',
              path: ['amendedPublicText'],
              message: 'Field exclusion cannot include replacement text.',
            })
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await resolveInterviewClarification({
          db: ctx.db,
          actorId: ctx.session.userId!,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          requestId: input.requestId,
          expectedReviewHash: input.expectedReviewHash,
          clarificationId: input.clarificationId,
          expectedAnsweredAt: input.expectedAnsweredAt,
          kind: input.kind,
          ...(input.amendedPublicText === undefined
            ? {}
            : { amendedPublicText: input.amendedPublicText }),
          rationale: input.rationale,
        })
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
