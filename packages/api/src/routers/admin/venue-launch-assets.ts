import { z } from 'zod'
import { db, resolveVenueLaunchSource, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { renderVenueLaunchAsset } from '../../lib/venue-launch-asset'

export const adminVenueLaunchAssetsRouter = router({
  getVenueLaunchAsset: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          format: z.enum(['SVG', 'PNG', 'PDF']).optional(),
        })
        .strict(),
    )
    .query(async ({ input }) => {
      const source = await withTenantIsolationBypass(() =>
        db.$transaction(
          (client) =>
            resolveVenueLaunchSource({
              client,
              tenantId: input.tenantId,
              venueId: input.venueId,
              configuredOrigin: process.env.NEXT_PUBLIC_WEB_URL,
            }),
          { isolationLevel: 'RepeatableRead' },
        ),
      )
      return source ? renderVenueLaunchAsset(source, input.format) : null
    }),
})
