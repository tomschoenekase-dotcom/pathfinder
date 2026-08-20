import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { resolveProductEntitlement } from '@pathfinder/db'

import { router } from '../core'
import { publicProcedure } from '../trpc'

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
      // Deliberate public cross-tenant lookup: venue and anonymous token are joined
      // before any tenant-scoped structured location lookup is attempted.
      const [scope] = await ctx.db.$queryRaw<
        Array<{ tenantId: string; venueId: string; experienceScope: string }>
      >`
        SELECT s.tenant_id AS "tenantId", s.venue_id AS "venueId", s.experience_scope AS "experienceScope"
          FROM visitor_sessions s
          JOIN venues v ON v.id = s.venue_id AND v.tenant_id = s.tenant_id
         WHERE s.anonymous_token = ${input.anonymousToken}
           AND s.venue_id = ${input.venueId}
           AND v.is_active = true
         LIMIT 1
      `
      if (!scope || scope.experienceScope !== 'PUBLIC')
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Location not found.' })
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
})
