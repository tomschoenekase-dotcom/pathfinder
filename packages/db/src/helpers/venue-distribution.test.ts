import { beforeEach, describe, expect, it, vi } from 'vitest'

const entitlement = vi.hoisted(() => vi.fn())
vi.mock('./product-entitlements', () => ({ resolveProductEntitlement: entitlement }))

import {
  createVenueDistributionResolverCache,
  getVenueDistributionSessionCounts,
  normalizeVenueWebsiteOrigin,
  resolveVenueDistribution,
} from './venue-distribution'

const queryRaw = vi.fn()
const findDistribution = vi.fn()
const findOrigins = vi.fn()
const client = {
  $queryRaw: queryRaw,
  venueDistribution: { findFirst: findDistribution },
  venueWebsiteOrigin: { findMany: findOrigins },
  tenant: {},
  productEntitlementOverride: {},
  productPlanCapability: {},
  billingAccount: {},
  tenantFeatureFlag: {},
} as never

describe('venue distribution resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryRaw.mockResolvedValue([{ id: 'venue-1', tenantId: 'tenant-1', isActive: true }])
    findDistribution.mockResolvedValue({
      websiteState: 'ENABLED',
      appState: 'ENABLED',
      revision: 4,
    })
    findOrigins.mockResolvedValue([{ origin: 'https://example.org' }])
    entitlement.mockImplementation(async ({ capability }) => ({
      enabled: capability === 'widget' || capability === 'app-webview',
    }))
  })

  it('separates enabled same-origin preview from third-party framing', async () => {
    const allowed = await resolveVenueDistribution({
      client,
      venueSlug: 'museum',
      env: { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' },
    })
    expect(allowed?.website).toEqual({
      effective: true,
      reason: null,
      origins: ['https://example.org'],
      framed: true,
      frameReason: null,
    })
    expect(allowed?.app).toEqual({ effective: true, reason: null })

    const flagOff = await resolveVenueDistribution({ client, venueSlug: 'museum', env: {} })
    expect(flagOff?.website.reason).toBe('FLAG_OFF')
    expect(flagOff?.app.reason).toBe('FLAG_OFF')

    findOrigins.mockResolvedValueOnce([])
    const noOrigins = await resolveVenueDistribution({
      client,
      venueSlug: 'museum',
      env: { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' },
    })
    expect(noOrigins?.website).toEqual({
      effective: true,
      reason: null,
      origins: [],
      framed: false,
      frameReason: 'NO_ORIGINS',
    })
    expect(noOrigins?.app.effective).toBe(true)
  })

  it('denies inactive venues, missing distribution rows and denied entitlements', async () => {
    queryRaw.mockResolvedValueOnce([{ id: 'venue-1', tenantId: 'tenant-1', isActive: false }])
    const inactive = await resolveVenueDistribution({
      client,
      venueSlug: 'museum',
      env: { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' },
    })
    expect(inactive?.website.reason).toBe('VENUE_INACTIVE')

    findDistribution.mockResolvedValueOnce(null)
    const disabled = await resolveVenueDistribution({
      client,
      venueSlug: 'museum',
      env: { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' },
    })
    expect(disabled?.website.reason).toBe('SURFACE_DISABLED')

    entitlement.mockResolvedValue({ enabled: false })
    const denied = await resolveVenueDistribution({
      client,
      venueSlug: 'museum',
      env: { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' },
    })
    expect(denied?.website.reason).toBe('ENTITLEMENT_DENIED')
    expect(denied?.app.reason).toBe('ENTITLEMENT_DENIED')
    queryRaw.mockResolvedValueOnce([])
    await expect(
      resolveVenueDistribution({ client, venueSlug: 'missing', env: {} }),
    ).resolves.toBeNull()
  })

  it('normalizes exact HTTPS origins and rejects paths, credentials, wildcards and HTTP', () => {
    expect(normalizeVenueWebsiteOrigin('https://EXAMPLE.org/')).toBe('https://example.org')
    for (const value of [
      'http://example.org',
      'https:example.org',
      'https://*.example.org',
      'https://user@example.org',
      'https://example.org/path',
    ]) {
      expect(normalizeVenueWebsiteOrigin(value)).toBeNull()
    }
  })

  it('counts only the scoped public venue sessions inside the 30-day window', async () => {
    const groupBy = vi.fn(async () => [
      { entrySurface: 'DIRECT', _count: { _all: 3 } },
      { entrySurface: 'QR', _count: { _all: 2 } },
      { entrySurface: null, _count: { _all: 1 } },
    ])
    const now = new Date('2026-09-26T12:00:00.000Z')
    const result = await getVenueDistributionSessionCounts(
      { visitorSession: { groupBy } } as never,
      'tenant-1',
      'venue-1',
      now,
    )
    expect(groupBy).toHaveBeenCalledWith({
      by: ['entrySurface'],
      where: {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        experienceScope: 'PUBLIC',
        startedAt: { gte: new Date('2026-08-27T12:00:00.000Z') },
      },
      _count: { _all: true },
    })
    expect(result).toEqual({ direct: 3, qr: 2, website: 0, app: 0, unknown: 1 })
  })
})

describe('venue distribution resolver cache', () => {
  it('single-flights, caches denials, expires at 30 seconds and evicts beyond its bound', async () => {
    let time = 0
    const resolve = vi.fn(async ({ venueSlug }: { venueSlug: string }) =>
      venueSlug === 'missing' ? null : ({ venueId: venueSlug } as never),
    )
    const cached = createVenueDistributionResolverCache({ resolve, now: () => time, maxEntries: 2 })
    await Promise.all([cached({ venueSlug: 'same' }), cached({ venueSlug: 'same' })])
    expect(resolve).toHaveBeenCalledTimes(1)
    await cached({ venueSlug: 'missing' })
    await cached({ venueSlug: 'missing' })
    expect(resolve).toHaveBeenCalledTimes(2)
    await cached({ venueSlug: 'third' })
    await cached({ venueSlug: 'same' })
    expect(resolve).toHaveBeenCalledTimes(4)
    time = 30_000
    await cached({ venueSlug: 'same' })
    expect(resolve).toHaveBeenCalledTimes(5)
  })

  it('converts read failures to a cached deny', async () => {
    let time = 0
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValue({ venueId: 'museum' })
    const cached = createVenueDistributionResolverCache({ resolve, now: () => time })
    await expect(cached({ venueSlug: 'museum' })).resolves.toBeNull()
    await expect(cached({ venueSlug: 'museum' })).resolves.toBeNull()
    expect(resolve).toHaveBeenCalledTimes(1)
    time = 5_000
    await expect(cached({ venueSlug: 'museum' })).resolves.toEqual({ venueId: 'museum' })
    expect(resolve).toHaveBeenCalledTimes(2)
  })
})
