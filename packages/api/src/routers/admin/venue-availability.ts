import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  lockVenueContentMutation,
  setContentVersionContext,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const targetInput = z
  .object({
    tenantId: z.string().min(1).max(128),
    venueId: z.string().min(1).max(128),
  })
  .strict()

export const adminVenueAvailabilityRouter = router({
  getVenueAvailability: adminProcedure.input(targetInput).query(async ({ input }) =>
    withTenantIsolationBypass(async () => {
      const venue = await db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true, isActive: true, updatedAt: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      return venue
    }),
  ),

  setVenueAvailability: adminProcedure
    .input(
      targetInput
        .extend({
          enabled: z.boolean(),
          expectedUpdatedAt: z.coerce.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (transaction) => {
          await setContentVersionContext(transaction, { actorId: ctx.session.userId })
          await lockVenueContentMutation(transaction, input)
          const before = await transaction.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true, isActive: true, updatedAt: true },
          })
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
          if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Venue availability changed; refresh and try again.',
            })
          }
          if (before.isActive === input.enabled) return { ...before, replayed: true }

          const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
          const changed = await transaction.venue.updateMany({
            where: {
              id: input.venueId,
              tenantId: input.tenantId,
              isActive: before.isActive,
              updatedAt: before.updatedAt,
            },
            data: { isActive: input.enabled, updatedAt },
          })
          if (changed.count !== 1) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Venue availability changed; refresh and try again.',
            })
          }

          await transaction.auditLog.create({
            data: {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.enabled
                ? 'admin.venue-availability.enabled'
                : 'admin.venue-availability.disabled',
              targetType: 'Venue',
              targetId: input.venueId,
              beforeState: { enabled: before.isActive },
              afterState: { enabled: input.enabled, reason: input.reason },
            },
          })

          return {
            id: before.id,
            isActive: input.enabled,
            updatedAt,
            replayed: false,
          }
        }),
      ),
    ),
})
