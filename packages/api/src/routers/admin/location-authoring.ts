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
  createLocationInput,
  exactCreateReplay,
  isUniqueConflict,
  locationAuthoringScope,
  projectLocation,
  updateLocationInput,
  validateLocationRelations,
} from './location-authoring-contract'

export const adminLocationAuthoringRouter = router({
  getVenueLocationAuthoring: adminProcedure
    .input(z.object(locationAuthoringScope).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: { id: true, name: true },
        })
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
        const [floors, locations, connections] = await Promise.all([
          db.venueFloor.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ sortOrder: 'asc' }, { stableKey: 'asc' }],
            take: 501,
          }),
          db.venueLocation.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ isActive: 'desc' }, { displayName: 'asc' }, { id: 'asc' }],
            take: 501,
          }),
          db.venueLocationConnection.findMany({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
            take: 501,
          }),
        ])
        if (floors.length > 500 || locations.length > 500 || connections.length > 500)
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Location authoring exceeds the bounded workspace size.',
          })
        return {
          venue,
          floors: floors.map((floor) => ({
            id: floor.id,
            stableKey: floor.stableKey,
            name: floor.name,
            level: floor.level,
            sortOrder: floor.sortOrder,
            mapImageUrl: floor.mapImageUrl,
            isActive: floor.isActive,
            updatedAt: floor.updatedAt,
          })),
          locations: locations.map(projectLocation),
          connections: connections.map((connection) => ({
            id: connection.id,
            fromLocationId: connection.fromLocationId,
            toLocationId: connection.toLocationId,
            kind: connection.kind,
            bidirectional: connection.bidirectional,
            accessible: connection.accessible,
            directions: connection.directions,
            isActive: connection.isActive,
            verifiedAt: connection.verifiedAt,
            updatedAt: connection.updatedAt,
          })),
        }
      }),
    ),

  createVenueLocationDraft: adminProcedure
    .input(createLocationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const existing = await tx.venueLocation.findFirst({
              where: { id: input.operationId, tenantId: input.tenantId, venueId: input.venueId },
            })
            if (existing) {
              const projected = projectLocation(existing)
              if (!exactCreateReplay(projected, input))
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Operation ID is already bound to a different location draft.',
                })
              return { location: projected, replayed: true }
            }
            const venue = await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
            await validateLocationRelations(tx, input)
            const created = await tx.venueLocation.create({
              data: {
                id: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                stableKey: input.stableKey,
                kind: input.kind,
                displayName: input.displayName,
                description: input.description,
                visibility: input.visibility,
                floorId: input.floorId,
                parentLocationId: input.parentLocationId,
                latitude: input.coordinates?.latitude ?? null,
                longitude: input.coordinates?.longitude ?? null,
                mapX: input.mapAnchor?.x ?? null,
                mapY: input.mapAnchor?.y ?? null,
                externalMapReference: input.externalMapReference,
                accessibilityMetadata: input.accessibilityMetadata,
                verifiedAt: new Date(),
                verifiedBy: ctx.session.userId,
                isActive: false,
              },
            })
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                idempotencyKey: input.operationId,
                action: 'venue-location.draft-created',
                targetType: 'VenueLocation',
                targetId: created.id,
                afterState: {
                  venueId: input.venueId,
                  stableKey: input.stableKey,
                  visibility: input.visibility,
                  isActive: false,
                },
              },
              tx,
            )
            return { location: projectLocation(created), replayed: false }
          }),
        )
      } catch (error) {
        if (isUniqueConflict(error))
          throw new TRPCError({ code: 'CONFLICT', message: 'Stable key is already in use.' })
        throw error
      }
    }),

  updateVenueLocationDraft: adminProcedure
    .input(updateLocationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const before = await tx.venueLocation.findFirst({
              where: { id: input.locationId, tenantId: input.tenantId, venueId: input.venueId },
            })
            if (!before) throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
            if (before.isActive)
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Deactivate this anchor before changing its reviewed content.',
              })
            if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime())
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Location changed; refresh and review it again.',
              })
            await validateLocationRelations(tx, input)
            const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
            const changed = await tx.venueLocation.updateMany({
              where: {
                id: before.id,
                tenantId: input.tenantId,
                venueId: input.venueId,
                updatedAt: before.updatedAt,
                isActive: false,
              },
              data: {
                stableKey: input.stableKey,
                kind: input.kind,
                displayName: input.displayName,
                description: input.description,
                visibility: input.visibility,
                floorId: input.floorId,
                parentLocationId: input.parentLocationId,
                latitude: input.coordinates?.latitude ?? null,
                longitude: input.coordinates?.longitude ?? null,
                mapX: input.mapAnchor?.x ?? null,
                mapY: input.mapAnchor?.y ?? null,
                externalMapReference: input.externalMapReference,
                accessibilityMetadata: input.accessibilityMetadata,
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
                action: 'venue-location.draft-updated',
                targetType: 'VenueLocation',
                targetId: before.id,
                beforeState: {
                  stableKey: before.stableKey,
                  displayName: before.displayName,
                  updatedAt: before.updatedAt.toISOString(),
                },
                afterState: {
                  stableKey: input.stableKey,
                  displayName: input.displayName,
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
        if (isUniqueConflict(error))
          throw new TRPCError({ code: 'CONFLICT', message: 'Stable key is already in use.' })
        throw error
      }
    }),

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
