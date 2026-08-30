import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  lockVenueContentMutation,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  locationAuthoringScope,
  projectLocation,
  validateLocationRelations,
} from './location-authoring-contract'

export const adminLocationAvailabilityRouter = router({
  setVenueLocationAvailability: adminProcedure
    .input(
      z
        .object({
          ...locationAuthoringScope,
          locationId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          active: z.boolean(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          await lockVenueContentMutation(tx, input)
          const before = await tx.venueLocation.findFirst({
            where: { id: input.locationId, tenantId: input.tenantId, venueId: input.venueId },
          })
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
          if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Location changed; refresh and review it again.',
            })
          if (input.active)
            await validateLocationRelations(tx, {
              tenantId: input.tenantId,
              venueId: input.venueId,
              floorId: before.floorId,
              parentLocationId: before.parentLocationId,
              locationId: before.id,
            })
          if (!input.active) {
            const [activeChild, activeConnection] = await Promise.all([
              tx.venueLocation.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  parentLocationId: before.id,
                  isActive: true,
                },
                select: { id: true },
              }),
              tx.venueLocationConnection.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  isActive: true,
                  OR: [{ fromLocationId: before.id }, { toLocationId: before.id }],
                },
                select: { id: true },
              }),
            ])
            if (activeChild || activeConnection) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message:
                  'Deactivate active child anchors and connections before deactivating this anchor.',
              })
            }
          }
          if (before.isActive === input.active)
            return { location: projectLocation(before), replayed: true }
          const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
          const changed = await tx.venueLocation.updateMany({
            where: {
              id: before.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
              updatedAt: before.updatedAt,
              isActive: before.isActive,
            },
            data: {
              isActive: input.active,
              verifiedAt: updatedAt,
              verifiedBy: ctx.session.userId,
              updatedAt,
            },
          })
          if (changed.count !== 1)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Location changed; refresh and review it again.',
            })
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.active ? 'venue-location.activated' : 'venue-location.deactivated',
              targetType: 'VenueLocation',
              targetId: before.id,
              beforeState: { isActive: before.isActive, updatedAt: before.updatedAt.toISOString() },
              afterState: {
                isActive: input.active,
                updatedAt: updatedAt.toISOString(),
                reason: input.reason,
              },
            },
            tx,
          )
          return {
            location: projectLocation({
              ...before,
              isActive: input.active,
              verifiedAt: updatedAt,
              verifiedBy: ctx.session.userId,
              updatedAt,
            }),
            replayed: false,
          }
        }),
      ),
    ),
})
