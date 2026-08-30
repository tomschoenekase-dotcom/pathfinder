import { z } from 'zod'

import { logger } from '@pathfinder/config'
import {
  IntakeFileExtractionReviewActionError,
  reviewIntakeFileExtractionAction,
} from '@pathfinder/db'

import { publicTRPCError, router } from '../../core'
import {
  executeIntakeFileExtraction,
  IntakeFileExtractionError,
} from '../../lib/intake-file-extraction-service'
import { adminProcedure } from '../../trpc'

export const adminIntakeFileExtractionRouter = router({
  executeIntakeFileExtraction: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          runId: z.string().trim().min(1).max(191),
          operationId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await executeIntakeFileExtraction({
          db: ctx.db,
          ...input,
          createdBy: ctx.session.userId,
        })
      } catch (error) {
        if (error instanceof IntakeFileExtractionError) {
          logger.warn({
            action: 'intake.file-extraction.rejected',
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.runId,
            errorCode: error.code,
            error: error.message,
          })
          throw publicTRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'PRECONDITION_FAILED',
            message: error.message,
          })
        }
        throw error
      }
    }),
  reviewIntakeFileExtraction: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          sourceRunId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          operationId: z.string().uuid(),
          expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
          decision: z.enum(['ACCEPTED_FOR_PROPOSAL', 'REJECTED']),
          proposalTitle: z.string().trim().min(1).max(255).optional(),
          proposalNotes: z.string().trim().min(1).max(20_000).optional(),
          rationale: z.string().trim().min(1).max(500),
        })
        .strict()
        .superRefine((value, context) => {
          const accepted = value.decision === 'ACCEPTED_FOR_PROPOSAL'
          if (accepted !== Boolean(value.proposalTitle && value.proposalNotes)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['decision'],
              message: accepted
                ? 'Accepted reviews require a proposal title and reviewed notes.'
                : 'Rejected reviews cannot retain proposal content.',
            })
          }
        }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await reviewIntakeFileExtractionAction(
          { ...input, createdBy: ctx.session.userId },
          ctx.db,
        )
      } catch (error) {
        if (error instanceof IntakeFileExtractionReviewActionError) {
          logger.warn({
            action: 'intake.file-extraction-review.rejected',
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.sourceRunId,
            receiptId: input.receiptId,
            errorCode: error.code,
            error: error.message,
          })
          throw publicTRPCError({
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
})
