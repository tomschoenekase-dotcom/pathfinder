import { z } from 'zod'

import { logger } from '@pathfinder/config'

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
})
