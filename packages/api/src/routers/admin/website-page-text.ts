import { logger } from '@pathfinder/config'
import { z } from 'zod'

import { publicTRPCError, router } from '../../core'
import {
  listWebsitePageText,
  readWebsitePageText,
  WebsitePageTextReaderError,
} from '../../lib/website-page-text-reader'
import { adminProcedure } from '../../trpc'

export const adminWebsitePageTextRouter = router({
  listWebsitePageText: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listWebsitePageText(input, ctx.db)
      } catch (error) {
        if (error instanceof WebsitePageTextReaderError) {
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
  readWebsitePageText: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
          runId: z.string().trim().min(1).max(191),
          receiptId: z.string().uuid(),
          sourceUrl: z.string().url().max(2_048),
          expectedExactByteHash: z.string().regex(/^[a-f0-9]{64}$/u),
          expectedRetainedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
          cursor: z.string().min(1).max(1_024).optional(),
          pageSize: z.number().int().min(1).max(4_000).optional(),
          search: z.string().trim().min(1).max(200).optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await readWebsitePageText(input, ctx.db)
      } catch (error) {
        if (error instanceof WebsitePageTextReaderError) {
          logger.warn({
            action: 'intake.website-page-text-reader.rejected',
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: input.runId,
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
