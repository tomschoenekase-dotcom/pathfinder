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
import { isUniqueConflict, locationAuthoringScope } from './location-authoring-contract'
import {
  createFloorInput,
  exactFloorReplay,
  projectFloor,
  updateFloorInput,
} from './location-topology-contract'

export const adminLocationFloorAuthoringRouter = router({
  createVenueFloorDraft: adminProcedure.input(createFloorInput).mutation(async ({ ctx, input }) => {
    try {
      return await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          await lockVenueContentMutation(tx, input)
          const existing = await tx.venueFloor.findFirst({
            where: { id: input.operationId, tenantId: input.tenantId, venueId: input.venueId },
          })
          if (existing) {
            const floor = projectFloor(existing)
            if (!exactFloorReplay(floor, input)) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Operation ID is already bound to a different floor draft.',
              })
            }
            return { floor, replayed: true }
          }
          const venue = await tx.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          })
          if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
          const created = await tx.venueFloor.create({
            data: {
              id: input.operationId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              stableKey: input.stableKey,
              name: input.name,
              level: input.level,
              sortOrder: input.sortOrder,
              mapImageUrl: input.mapImageUrl,
              isActive: false,
            },
          })
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              idempotencyKey: input.operationId,
              action: 'venue-floor.draft-created',
              targetType: 'VenueFloor',
              targetId: created.id,
              afterState: { venueId: input.venueId, stableKey: input.stableKey, isActive: false },
            },
            tx,
          )
          return { floor: projectFloor(created), replayed: false }
        }),
      )
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Floor stable key is already in use.' })
      }
      throw error
    }
  }),

  updateVenueFloorDraft: adminProcedure.input(updateFloorInput).mutation(async ({ ctx, input }) => {
    try {
      return await withTenantIsolationBypass(() =>
        db.$transaction(async (tx) => {
          await lockVenueContentMutation(tx, input)
          const before = await tx.venueFloor.findFirst({
            where: { id: input.floorId, tenantId: input.tenantId, venueId: input.venueId },
          })
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Floor not found.' })
          if (before.isActive) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Deactivate this floor before changing its reviewed content.',
            })
          }
          if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Floor changed; refresh and review it again.',
            })
          }
          const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
          const changed = await tx.venueFloor.updateMany({
            where: {
              id: before.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
              updatedAt: before.updatedAt,
              isActive: false,
            },
            data: {
              stableKey: input.stableKey,
              name: input.name,
              level: input.level,
              sortOrder: input.sortOrder,
              mapImageUrl: input.mapImageUrl,
              updatedAt,
            },
          })
          if (changed.count !== 1) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Floor changed; refresh and review it again.',
            })
          }
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: 'venue-floor.draft-updated',
              targetType: 'VenueFloor',
              targetId: before.id,
              beforeState: {
                stableKey: before.stableKey,
                name: before.name,
                updatedAt: before.updatedAt.toISOString(),
              },
              afterState: {
                stableKey: input.stableKey,
                name: input.name,
                updatedAt: updatedAt.toISOString(),
                reason: input.reason,
              },
            },
            tx,
          )
          return { updatedAt }
        }),
      )
    } catch (error) {
      if (isUniqueConflict(error)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Floor stable key is already in use.' })
      }
      throw error
    }
  }),

  setVenueFloorAvailability: adminProcedure
    .input(
      z
        .object({
          ...locationAuthoringScope,
          floorId: z.string().uuid(),
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
          const before = await tx.venueFloor.findFirst({
            where: { id: input.floorId, tenantId: input.tenantId, venueId: input.venueId },
          })
          if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Floor not found.' })
          if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Floor changed; refresh and review it again.',
            })
          }
          if (before.isActive === input.active) {
            return { floor: projectFloor(before), replayed: true }
          }
          if (!input.active) {
            const activeLocation = await tx.venueLocation.findFirst({
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                floorId: before.id,
                isActive: true,
              },
              select: { id: true },
            })
            if (activeLocation) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Deactivate active anchors on this floor before deactivating it.',
              })
            }
          }
          const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
          const changed = await tx.venueFloor.updateMany({
            where: {
              id: before.id,
              tenantId: input.tenantId,
              venueId: input.venueId,
              updatedAt: before.updatedAt,
              isActive: before.isActive,
            },
            data: { isActive: input.active, updatedAt },
          })
          if (changed.count !== 1) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Floor changed; refresh and review it again.',
            })
          }
          await writeAuditLogStrict(
            {
              tenantId: input.tenantId,
              actorId: ctx.session.userId,
              actorRole: 'PLATFORM_ADMIN',
              action: input.active ? 'venue-floor.activated' : 'venue-floor.deactivated',
              targetType: 'VenueFloor',
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
            floor: projectFloor({ ...before, isActive: input.active, updatedAt }),
            replayed: false,
          }
        }),
      ),
    ),
})
