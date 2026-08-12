import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import {
  db,
  updateWeeklyReportConfigurationAction,
  WeeklyReportActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { findVenueReportConfiguration } from '../../lib/venue-report-configuration'
import { adminProcedure } from '../../trpc'

export const adminReportConfigurationRouter = router({
  getVenueReportConfiguration: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string() }).strict())
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

        const configuration = await findVenueReportConfiguration(db, input.tenantId, input.venueId)
        return (
          configuration ?? {
            id: null,
            tenantId: input.tenantId,
            venueId: input.venueId,
            enabled: false,
            updatedBy: null,
            createdAt: null,
            updatedAt: null,
          }
        )
      }),
    ),

  updateVenueReportConfiguration: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string(),
          venueId: z.string(),
          enabled: z.boolean(),
          expectedUpdatedAt: z.coerce.date().nullable(),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          updateWeeklyReportConfigurationAction(
            {
              ...input,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
      } catch (error) {
        if (!(error instanceof WeeklyReportActionError)) throw error
        throw new TRPCError({
          code:
            error.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : error.code === 'CONFLICT'
                ? 'CONFLICT'
                : 'BAD_REQUEST',
          message: error.message,
          cause: error,
        })
      }
    }),
})
