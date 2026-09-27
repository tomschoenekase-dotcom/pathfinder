import {
  isAppDistributionEnabled,
  isWebsiteDistributionEnabled,
} from '@pathfinder/config/feature-flags'

import { db } from '../client'
import { resolveProductEntitlement } from './product-entitlements'

export type DistributionDenyReason =
  | 'FLAG_OFF'
  | 'VENUE_INACTIVE'
  | 'ENTITLEMENT_DENIED'
  | 'SURFACE_DISABLED'
  | 'NO_ORIGINS'

export type VenueDistributionReadback = {
  venueId: string
  tenantId: string
  venueActive: boolean
  website: {
    effective: boolean
    reason: DistributionDenyReason | null
    origins: readonly string[]
    framed: boolean
    frameReason: 'NO_ORIGINS' | null
  }
  app: { effective: boolean; reason: DistributionDenyReason | null }
  revision: number
}

export async function getVenueDistributionSessionCounts(
  client: Pick<typeof db, 'visitorSession'>,
  tenantId: string,
  venueId: string,
  now = new Date(),
) {
  const startDate = new Date(now)
  startDate.setUTCDate(startDate.getUTCDate() - 30)
  const rows = await client.visitorSession.groupBy({
    by: ['entrySurface'],
    where: { tenantId, venueId, experienceScope: 'PUBLIC', startedAt: { gte: startDate } },
    _count: { _all: true },
  })
  const counts = new Map(rows.map((row) => [row.entrySurface ?? 'UNKNOWN', row._count._all]))
  return {
    direct: counts.get('DIRECT') ?? 0,
    qr: counts.get('QR') ?? 0,
    website: counts.get('WEBSITE') ?? 0,
    app: counts.get('APP') ?? 0,
    unknown: counts.get('UNKNOWN') ?? 0,
  }
}

export function normalizeVenueWebsiteOrigin(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value.trim() !== value ||
    /[^\x21-\x7e]/u.test(value) ||
    value.includes('*') ||
    !/^https:\/\//iu.test(value)
  )
    return null
  try {
    const url = new URL(value)
    const authorityAndPath = value.slice(value.indexOf('://') + 3)
    const authority = authorityAndPath.endsWith('/')
      ? authorityAndPath.slice(0, -1)
      : authorityAndPath
    if (
      url.protocol !== 'https:' ||
      url.hostname.includes('*') ||
      /[/?#]/u.test(authority) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return null
    return url.origin
  } catch {
    return null
  }
}

type DistributionClient = Pick<
  typeof db,
  | '$queryRaw'
  | 'venue'
  | 'venueDistribution'
  | 'venueWebsiteOrigin'
  | 'productEntitlementOverride'
  | 'tenant'
  | 'productPlanCapability'
  | 'billingAccount'
  | 'tenantFeatureFlag'
>

type ResolveParams = {
  client: DistributionClient
  venueSlug: string
  venueTarget?: { venueId: string; tenantId: string }
  env?: Readonly<Record<string, string | undefined>>
  now?: Date
}

/** One public slug lookup; all policy/configuration reads after it are tenant-bound. */
export async function resolveVenueDistribution(
  params: ResolveParams,
): Promise<VenueDistributionReadback | null> {
  // Public calls use the deliberately bounded slug lookup and deny ambiguous slugs.
  // Admin/tenant readbacks pass a venue already selected under their tenant boundary.
  const venues = params.venueTarget
    ? null
    : await params.client.$queryRaw<Array<{ id: string; tenantId: string; isActive: boolean }>>`
    SELECT id, tenant_id AS "tenantId", is_active AS "isActive"
      FROM venues WHERE slug = ${params.venueSlug} LIMIT 2
  `
  const scopedVenue = params.venueTarget
    ? await params.client.venue.findFirst({
        where: { id: params.venueTarget.venueId, tenantId: params.venueTarget.tenantId },
        select: { id: true, tenantId: true, isActive: true },
      })
    : null
  const venue = params.venueTarget ? scopedVenue : venues?.length === 1 ? venues[0] : null
  if (!venue) return null

  const [distribution, origins, websiteEntitlement, appEntitlement] = await Promise.all([
    params.client.venueDistribution.findFirst({
      where: { tenantId: venue.tenantId, venueId: venue.id },
      select: { websiteState: true, appState: true, revision: true },
    }),
    params.client.venueWebsiteOrigin.findMany({
      where: { tenantId: venue.tenantId, venueId: venue.id, state: 'ACTIVE' },
      orderBy: { origin: 'asc' },
      select: { origin: true },
      take: 21,
    }),
    resolveProductEntitlement({
      client: params.client,
      tenantId: venue.tenantId,
      venueId: venue.id,
      capability: 'widget',
      featureAvailable: isWebsiteDistributionEnabled(params.env),
      ...(params.now ? { now: params.now } : {}),
    }),
    resolveProductEntitlement({
      client: params.client,
      tenantId: venue.tenantId,
      venueId: venue.id,
      capability: 'app-webview',
      featureAvailable: isAppDistributionEnabled(params.env),
      ...(params.now ? { now: params.now } : {}),
    }),
  ])

  const activeOrigins = origins.slice(0, 20).map(({ origin }) => origin)
  const websiteReason = !isWebsiteDistributionEnabled(params.env)
    ? 'FLAG_OFF'
    : !venue.isActive
      ? 'VENUE_INACTIVE'
      : !websiteEntitlement.enabled
        ? 'ENTITLEMENT_DENIED'
        : distribution?.websiteState !== 'ENABLED'
          ? 'SURFACE_DISABLED'
          : null
  const appReason = !isAppDistributionEnabled(params.env)
    ? 'FLAG_OFF'
    : !venue.isActive
      ? 'VENUE_INACTIVE'
      : !appEntitlement.enabled
        ? 'ENTITLEMENT_DENIED'
        : distribution?.appState !== 'ENABLED'
          ? 'SURFACE_DISABLED'
          : null

  return {
    venueId: venue.id,
    tenantId: venue.tenantId,
    venueActive: venue.isActive,
    website: {
      effective: websiteReason === null,
      reason: websiteReason,
      origins: activeOrigins,
      framed: websiteReason === null && activeOrigins.length > 0,
      frameReason: websiteReason === null && activeOrigins.length === 0 ? 'NO_ORIGINS' : null,
    },
    app: { effective: appReason === null, reason: appReason },
    revision: distribution?.revision ?? 0,
  }
}

type Resolver = (input: { venueSlug: string }) => Promise<VenueDistributionReadback | null>
type CacheEntry = { expiresAt: number; promise: Promise<VenueDistributionReadback | null> }

/** Bounded single-flight cache used by read paths with strict fail-closed behavior. */
export function createVenueDistributionResolverCache(options: {
  resolve: Resolver
  now?: () => number
  ttlMs?: number
  errorTtlMs?: number
  maxEntries?: number
}): Resolver {
  const entries = new Map<string, CacheEntry>()
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 30_000
  const errorTtlMs = options.errorTtlMs ?? 5_000
  const maxEntries = options.maxEntries ?? 500
  return async ({ venueSlug }) => {
    const time = now()
    const cached = entries.get(venueSlug)
    if (cached && cached.expiresAt > time) {
      entries.delete(venueSlug)
      entries.set(venueSlug, cached)
      return cached.promise
    }
    if (cached) entries.delete(venueSlug)

    const entry: CacheEntry = { expiresAt: time + ttlMs, promise: Promise.resolve(null) }
    const promise = Promise.resolve()
      .then(() => options.resolve({ venueSlug }))
      .catch(() => {
        // A transient storage error denies this request but must not hide a
        // recovered venue for the full successful-result TTL.
        if (entries.get(venueSlug) === entry) entry.expiresAt = now() + errorTtlMs
        return null
      })
    entry.promise = promise
    entries.set(venueSlug, entry)
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value
      if (oldest === undefined) break
      entries.delete(oldest)
    }
    return promise
  }
}

export function createDefaultVenueDistributionResolverCache(
  client: DistributionClient,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createVenueDistributionResolverCache({
    resolve: ({ venueSlug }) => resolveVenueDistribution({ client, venueSlug, env }),
  })
}

// Public reads share one bounded cache per actual Prisma client. Admin and
// tenant readbacks deliberately call the uncached resolver above.
const publicResolverCaches = new WeakMap<DistributionClient, Resolver>()

export function resolveCachedVenueDistribution(input: {
  venueSlug: string
  client?: DistributionClient
}): Promise<VenueDistributionReadback | null> {
  const client = input.client ?? db
  let resolve = publicResolverCaches.get(client)
  if (!resolve) {
    resolve = createDefaultVenueDistributionResolverCache(client)
    publicResolverCaches.set(client, resolve)
  }
  return resolve({ venueSlug: input.venueSlug })
}
