import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { resolveProductEntitlement } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { publicProcedure } from '../trpc'
import { findDeterministicRoutePlan, projectRouteLocation } from './location-route'
import { loadPublicLocationScope } from './location-public-scope'

const safeExternalMap = z
  .string()
  .url()
  .max(2000)
  .refine((value) => {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return false
    return ![...parsed.searchParams.keys()].some((key) =>
      /token|key|secret|signature|credential|auth|password/iu.test(key),
    )
  })

async function loadPublicRouteLocations(
  db: TRPCContext['db'],
  scope: { tenantId: string; venueId: string },
  now: Date,
) {
  const locations = await db.venueLocation.findMany({
    where: {
      tenantId: scope.tenantId,
      venueId: scope.venueId,
      visibility: 'PUBLIC',
      isActive: true,
      verifiedAt: { lte: now },
      OR: [{ floorId: null }, { floor: { isActive: true } }],
    },
    orderBy: [{ stableKey: 'asc' }, { id: 'asc' }],
    take: 501,
    select: {
      id: true,
      stableKey: true,
      kind: true,
      displayName: true,
      floor: { select: { id: true, stableKey: true, name: true, level: true } },
    },
  })
  if (locations.length > 500)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'This venue topology exceeds the supported route size.',
    })
  return locations
}

async function requirePublicLocationEntitlement(
  db: TRPCContext['db'],
  scope: { tenantId: string; venueId: string },
  notFoundMessage: string,
) {
  const entitlement = await resolveProductEntitlement({
    client: db,
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    capability: 'location-plus',
    featureAvailable: true,
  })
  if (!entitlement.enabled) throw new TRPCError({ code: 'NOT_FOUND', message: notFoundMessage })
}

export const locationRouter = router({
  resolve: publicProcedure
    .input(
      z
        .object({
          venueId: z.string().min(1).max(191),
          anonymousToken: z.string().uuid(),
          locationId: z.string().min(1).max(191),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const scope = await loadPublicLocationScope(ctx.db, input)
      if (!scope) throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
      const entitlement = await resolveProductEntitlement({
        client: ctx.db,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        capability: 'location-plus',
        featureAvailable: true,
      })
      if (!entitlement.enabled)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
      const location = await ctx.db.venueLocation.findFirst({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          OR: [{ id: input.locationId }, { stableKey: input.locationId }],
          visibility: 'PUBLIC',
          isActive: true,
          verifiedAt: { lte: new Date() },
        },
        select: {
          id: true,
          stableKey: true,
          kind: true,
          displayName: true,
          description: true,
          latitude: true,
          longitude: true,
          mapX: true,
          mapY: true,
          externalMapReference: true,
          accessibilityMetadata: true,
          verifiedAt: true,
          floor: { select: { stableKey: true, name: true, level: true } },
        },
      })
      if (!location) throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
      const parsedMap = location.externalMapReference
        ? safeExternalMap.safeParse(location.externalMapReference)
        : null
      return {
        id: location.id,
        stableKey: location.stableKey,
        kind: location.kind,
        displayName: location.displayName,
        description: location.description,
        floor: location.floor,
        coordinates:
          location.latitude !== null && location.longitude !== null
            ? { latitude: Number(location.latitude), longitude: Number(location.longitude) }
            : null,
        mapAnchor:
          location.mapX !== null && location.mapY !== null
            ? { x: Number(location.mapX), y: Number(location.mapY) }
            : null,
        externalMapUrl: parsedMap?.success ? parsedMap.data : null,
        accessibility: location.accessibilityMetadata,
        verifiedAt: location.verifiedAt,
      }
    }),

  catalog: publicProcedure
    .input(
      z
        .object({
          venueId: z.string().min(1).max(191),
          anonymousToken: z.string().uuid(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const scope = await loadPublicLocationScope(ctx.db, input)
      // The catalog is optional visitor UI. An empty projection keeps missing,
      // private, and unentitled topology indistinguishable without turning a
      // normal feature-discovery request into a browser-visible 404.
      if (!scope) return { locations: [] }
      const entitlement = await resolveProductEntitlement({
        client: ctx.db,
        tenantId: scope.tenantId,
        venueId: scope.venueId,
        capability: 'location-plus',
        featureAvailable: true,
      })
      if (!entitlement.enabled) return { locations: [] }
      const locations = await loadPublicRouteLocations(ctx.db, scope, new Date())
      return { locations: locations.map(projectRouteLocation) }
    }),

  route: publicProcedure
    .input(
      z
        .object({
          venueId: z.string().min(1).max(191),
          anonymousToken: z.string().uuid(),
          fromLocationId: z.string().min(1).max(191),
          toLocationId: z.string().min(1).max(191),
          accessibleOnly: z.boolean().default(false),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const scope = await loadPublicLocationScope(ctx.db, input)
      if (!scope) throw new TRPCError({ code: 'NOT_FOUND', message: 'Location route not found.' })
      await requirePublicLocationEntitlement(ctx.db, scope, 'Location route not found.')

      const now = new Date()
      const locations = await loadPublicRouteLocations(ctx.db, scope, now)
      const resolveLocationId = (value: string) =>
        locations.find((location) => location.id === value || location.stableKey === value)?.id
      const fromLocationId = resolveLocationId(input.fromLocationId)
      const toLocationId = resolveLocationId(input.toLocationId)
      if (!fromLocationId || !toLocationId)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Location route not found.' })
      if (fromLocationId === toLocationId)
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Choose two different locations.',
        })

      const connections = await ctx.db.venueLocationConnection.findMany({
        where: {
          tenantId: scope.tenantId,
          venueId: scope.venueId,
          isActive: true,
          verifiedAt: { lte: now },
          ...(input.accessibleOnly ? { accessible: true } : {}),
        },
        orderBy: [{ id: 'asc' }],
        take: 1001,
        select: {
          id: true,
          fromLocationId: true,
          toLocationId: true,
          kind: true,
          bidirectional: true,
          accessible: true,
          directions: true,
          verifiedAt: true,
        },
      })
      if (connections.length > 1000)
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This venue topology exceeds the supported route size.',
        })
      const routePlan = findDeterministicRoutePlan({
        locations,
        connections,
        fromLocationId,
        toLocationId,
      })
      if (!routePlan)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Location route not found.' })
      const byId = new Map(locations.map((location) => [location.id, location]))
      const describedSegmentCount = routePlan.steps.filter((step) =>
        Boolean(step.connection.directions?.trim()),
      ).length
      const reviewedAt = routePlan.steps.reduce<Date | null>((oldest, step) => {
        const verifiedAt = step.connection.verifiedAt
        return !oldest || verifiedAt < oldest ? verifiedAt : oldest
      }, null)
      return {
        from: projectRouteLocation(byId.get(fromLocationId)!),
        to: projectRouteLocation(byId.get(toLocationId)!),
        accessibleOnly: input.accessibleOnly,
        segmentCount: routePlan.steps.length,
        describedSegmentCount,
        guidanceConfidence:
          describedSegmentCount === routePlan.steps.length
            ? ('HIGH' as const)
            : ('LIMITED' as const),
        hasEquivalentRoute: routePlan.hasEquivalentRoute,
        review: {
          status: 'VENUE_REVIEWED' as const,
          reviewedAt,
        },
        segments: routePlan.steps.map((step) => ({
          connectionId: step.connection.id,
          kind: step.connection.kind,
          accessible: step.connection.accessible,
          directions: step.connection.directions,
          from: projectRouteLocation(byId.get(step.fromLocationId)!),
          to: projectRouteLocation(byId.get(step.toLocationId)!),
        })),
      }
    }),
})
