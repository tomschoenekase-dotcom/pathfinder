import { TRPCError } from '@trpc/server'

import { assertVenueAvailable, db, withTenantIsolationBypass } from '@pathfinder/db'

import {
  MediaTemporalReviewError,
  MediaTemporalReviewInput,
  previewMediaTemporalReview,
} from '../../lib/media-temporal-review'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const mediaIngestionTemporalRouter = router({
  previewTemporalReview: adminProcedure.input(MediaTemporalReviewInput).query(({ input }) =>
    withTenantIsolationBypass(async () => {
      await assertVenueAvailable(db, { tenantId: input.tenantId, venueId: input.venueId })
      try {
        return await previewMediaTemporalReview({
          db,
          input,
          evaluatedAt: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof MediaTemporalReviewError)
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'TOO_LARGE'
                  ? 'PAYLOAD_TOO_LARGE'
                  : 'PRECONDITION_FAILED',
            message: error.message,
            cause: error,
          })
        throw error
      }
    }),
  ),
})
