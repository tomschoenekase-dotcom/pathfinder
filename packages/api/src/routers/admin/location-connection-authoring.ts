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
  createConnectionInput,
  exactConnectionReplay,
  projectConnection,
  updateConnectionInput,
  validateConnectionLocations,
} from './location-topology-contract'

function normalizeTopologyError(error: unknown): never {
  if (isUniqueConflict(error)) {
    throw new TRPCError({ code: 'CONFLICT', message: 'This connection already exists.' })
  }
  if (error instanceof TRPCError) throw error
  if (error instanceof Error && error.message.startsWith('A connection requires')) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
  }
  if (error instanceof Error && error.message.startsWith('Both connection anchors')) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message })
  }
  throw error
}

export const adminLocationConnectionAuthoringRouter = router({
  createVenueLocationConnectionDraft: adminProcedure
    .input(createConnectionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const existing = await tx.venueLocationConnection.findFirst({
              where: { id: input.operationId, tenantId: input.tenantId, venueId: input.venueId },
            })
            if (existing) {
              const connection = projectConnection(existing)
              if (!exactConnectionReplay(connection, input)) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Operation ID is already bound to a different connection draft.',
                })
              }
              return { connection, replayed: true }
            }
            const venue = await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
            await validateConnectionLocations(tx, { ...input, requireActive: false })
            const now = new Date()
            const created = await tx.venueLocationConnection.create({
              data: {
                id: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                fromLocationId: input.fromLocationId,
                toLocationId: input.toLocationId,
                kind: input.kind,
                bidirectional: input.bidirectional,
                accessible: input.accessible,
                directions: input.directions,
                verifiedAt: now,
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
                action: 'venue-location-connection.draft-created',
                targetType: 'VenueLocationConnection',
                targetId: created.id,
                afterState: {
                  venueId: input.venueId,
                  fromLocationId: input.fromLocationId,
                  toLocationId: input.toLocationId,
                  kind: input.kind,
                  isActive: false,
                },
              },
              tx,
            )
            return { connection: projectConnection(created), replayed: false }
          }),
        )
      } catch (error) {
        normalizeTopologyError(error)
      }
    }),

  updateVenueLocationConnectionDraft: adminProcedure
    .input(updateConnectionInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const before = await tx.venueLocationConnection.findFirst({
              where: {
                id: input.connectionId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
            })
            if (!before) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found.' })
            }
            if (before.isActive) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Deactivate this connection before changing its reviewed content.',
              })
            }
            if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Connection changed; refresh and review it again.',
              })
            }
            await validateConnectionLocations(tx, { ...input, requireActive: false })
            const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
            const changed = await tx.venueLocationConnection.updateMany({
              where: {
                id: before.id,
                tenantId: input.tenantId,
                venueId: input.venueId,
                updatedAt: before.updatedAt,
                isActive: false,
              },
              data: {
                fromLocationId: input.fromLocationId,
                toLocationId: input.toLocationId,
                kind: input.kind,
                bidirectional: input.bidirectional,
                accessible: input.accessible,
                directions: input.directions,
                verifiedAt: updatedAt,
                verifiedBy: ctx.session.userId,
                updatedAt,
              },
            })
            if (changed.count !== 1) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Connection changed; refresh and review it again.',
              })
            }
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'venue-location-connection.draft-updated',
                targetType: 'VenueLocationConnection',
                targetId: before.id,
                beforeState: {
                  fromLocationId: before.fromLocationId,
                  toLocationId: before.toLocationId,
                  kind: before.kind,
                  updatedAt: before.updatedAt.toISOString(),
                },
                afterState: {
                  fromLocationId: input.fromLocationId,
                  toLocationId: input.toLocationId,
                  kind: input.kind,
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
        normalizeTopologyError(error)
      }
    }),

  setVenueLocationConnectionAvailability: adminProcedure
    .input(
      z
        .object({
          ...locationAuthoringScope,
          connectionId: z.string().uuid(),
          expectedUpdatedAt: z.coerce.date(),
          active: z.boolean(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const before = await tx.venueLocationConnection.findFirst({
              where: {
                id: input.connectionId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
            })
            if (!before) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Connection not found.' })
            }
            if (before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Connection changed; refresh and review it again.',
              })
            }
            if (input.active) {
              await validateConnectionLocations(tx, {
                tenantId: input.tenantId,
                venueId: input.venueId,
                fromLocationId: before.fromLocationId,
                toLocationId: before.toLocationId,
                requireActive: true,
              })
            }
            if (before.isActive === input.active) {
              return { connection: projectConnection(before), replayed: true }
            }
            const updatedAt = new Date(Math.max(Date.now(), before.updatedAt.getTime() + 1))
            const changed = await tx.venueLocationConnection.updateMany({
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
            if (changed.count !== 1) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Connection changed; refresh and review it again.',
              })
            }
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: input.active
                  ? 'venue-location-connection.activated'
                  : 'venue-location-connection.deactivated',
                targetType: 'VenueLocationConnection',
                targetId: before.id,
                beforeState: {
                  isActive: before.isActive,
                  updatedAt: before.updatedAt.toISOString(),
                },
                afterState: {
                  isActive: input.active,
                  updatedAt: updatedAt.toISOString(),
                  reason: input.reason,
                },
              },
              tx,
            )
            return {
              connection: projectConnection({
                ...before,
                isActive: input.active,
                verifiedAt: updatedAt,
                verifiedBy: ctx.session.userId,
                updatedAt,
              }),
              replayed: false,
            }
          }),
        )
      } catch (error) {
        normalizeTopologyError(error)
      }
    }),
})
