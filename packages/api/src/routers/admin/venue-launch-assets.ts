import { z } from 'zod'
import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { resolveVenueLaunchAsset } from '../../lib/venue-launch-asset'

export const adminVenueLaunchAssetsRouter = router({
  getVenueLaunchAsset: adminProcedure
    .input(
      z
        .object({ tenantId: z.string().min(1).max(191), venueId: z.string().min(1).max(191) })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(
          (client) =>
            resolveVenueLaunchAsset({
              client,
              ...input,
              configuredOrigin: process.env.NEXT_PUBLIC_WEB_URL,
            }),
          { isolationLevel: 'RepeatableRead' },
        ),
      ),
    ),
})
