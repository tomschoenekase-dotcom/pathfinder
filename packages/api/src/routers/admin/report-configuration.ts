import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, lockVenueReportMutation, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import {
  findVenueReportConfiguration,
  venueReportConfigurationSelect,
} from '../../lib/venue-report-configuration'
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
    .mutation(async ({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          await lockVenueReportMutation(transaction, input)
          const venue = await transaction.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })

          const before = await findVenueReportConfiguration(
            transaction,
            input.tenantId,
            input.venueId,
          )
          if (!before && input.expectedUpdatedAt !== null) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Report configuration changed; refresh and try again.',
            })
          }
          if (
            before &&
            (input.expectedUpdatedAt === null ||
              before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Report configuration changed; refresh and try again.',
            })
          }
          if (before?.enabled === input.enabled || (!before && !input.enabled)) {
            return {
              ...(before ?? {
                id: null,
                tenantId: input.tenantId,
                venueId: input.venueId,
                enabled: false,
                updatedBy: null,
                createdAt: null,
                updatedAt: null,
              }),
              replayed: true,
            }
          }

          const nextUpdatedAt = new Date(
            before ? Math.max(Date.now(), before.updatedAt.getTime() + 1) : Date.now(),
          )
          const configuration = before
            ? await transaction.venueReportConfiguration.update({
                where: { id: before.id },
                data: {
                  enabled: input.enabled,
                  updatedBy: ctx.session.userId,
                  updatedAt: nextUpdatedAt,
                },
                select: venueReportConfigurationSelect,
              })
            : await transaction.venueReportConfiguration.create({
                data: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  enabled: input.enabled,
                  updatedBy: ctx.session.userId,
                  updatedAt: nextUpdatedAt,
                },
                select: venueReportConfigurationSelect,
              })

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: configuration.enabled
                ? 'admin.venue-reports.enabled'
                : 'admin.venue-reports.disabled',
              targetType: 'VenueReportConfiguration',
              targetId: configuration.id,
              beforeState: { enabled: before?.enabled === true },
              afterState: { enabled: configuration.enabled },
            },
          })

          return { ...configuration, replayed: false }
        }),
      ),
    ),
})
