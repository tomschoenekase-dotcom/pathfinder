import { TRPCError } from '@trpc/server'
import { assertVenueAvailable, db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { ApplyMediaRelationInput } from '../../lib/media-relation-application'
import {
  applyMediaRelationDraft,
  MediaRelationApplicationError,
} from '../../lib/media-relation-application-service'

export const mediaIngestionRelationApplicationRouter = router({
  applyReviewedRelationDraft: adminProcedure
    .input(ApplyMediaRelationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(async () => {
          await assertVenueAvailable(db, input)
          return applyMediaRelationDraft({ client: db, input, actorId: ctx.session.userId })
        })
      } catch (error) {
        if (error instanceof MediaRelationApplicationError)
          throw new TRPCError({ code: error.code, message: error.message })
        throw error
      }
    }),
})
