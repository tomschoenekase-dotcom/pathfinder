import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { afterAll, describe, expect, it } from 'vitest'

import { resolveVenueDistribution } from './venue-distribution'

const enabled =
  process.env.RUN_DISTRIBUTION_DB_INTEGRATION === '1' &&
  /\/pathfinder_disposable_distribution_(?:rc1|backfill)$/u.test(process.env.DATABASE_URL ?? '')
const client = enabled ? new PrismaClient() : null

describe.skipIf(!enabled)('venue distribution disposable database boundary', () => {
  afterAll(async () => client?.$disconnect())

  it('denies ambiguous public slugs and frames only an admitted origin after all gates pass', async () => {
    if (!client) throw new Error('Disposable database not configured')
    const suffix = randomUUID().slice(0, 8)
    const tenantId = `distribution-tenant-${suffix}`
    const venueId = `distribution-venue-${suffix}`
    const slug = `distribution-fixture-${suffix}`
    const env = { WEBSITE_DISTRIBUTION_ENABLED: 'true', APP_DISTRIBUTION_ENABLED: 'true' }
    await client.tenant.create({
      data: {
        id: tenantId,
        name: 'Synthetic distribution tenant',
        slug: tenantId,
        planTier: tenantId,
      },
    })
    await client.venue.create({
      data: { id: venueId, tenantId, name: 'Synthetic distribution venue', slug },
    })
    await client.productPlanCapability.createMany({
      data: [
        {
          planTier: tenantId,
          capability: 'widget',
          enabled: true,
          createdBy: 'fixture',
          updatedBy: 'fixture',
        },
        {
          planTier: tenantId,
          capability: 'app-webview',
          enabled: true,
          createdBy: 'fixture',
          updatedBy: 'fixture',
        },
      ],
    })

    const disabled = await resolveVenueDistribution({
      client: client as never,
      venueSlug: slug,
      env,
    })
    expect(disabled?.website.reason).toBe('SURFACE_DISABLED')
    expect(disabled?.app.reason).toBe('SURFACE_DISABLED')

    await client.venueDistribution.create({
      data: {
        tenantId,
        venueId,
        websiteState: 'ENABLED',
        appState: 'ENABLED',
        updatedBy: 'fixture',
      },
    })
    const preview = await resolveVenueDistribution({
      client: client as never,
      venueSlug: slug,
      env,
    })
    expect(preview?.website).toMatchObject({
      effective: true,
      framed: false,
      frameReason: 'NO_ORIGINS',
    })
    expect(preview?.app.effective).toBe(true)

    await client.venueWebsiteOrigin.create({
      data: {
        tenantId,
        venueId,
        origin: 'https://admitted.example',
        addedBy: 'fixture',
        addedReason: 'Synthetic fixture',
      },
    })
    const admitted = await resolveVenueDistribution({
      client: client as never,
      venueSlug: slug,
      env,
    })
    expect(admitted?.website).toMatchObject({
      effective: true,
      framed: true,
      origins: ['https://admitted.example'],
    })

    const flagOff = await resolveVenueDistribution({
      client: client as never,
      venueSlug: slug,
      env: {},
    })
    expect(flagOff?.website.reason).toBe('FLAG_OFF')
    expect(flagOff?.app.reason).toBe('FLAG_OFF')

    const otherTenantId = `distribution-other-${suffix}`
    await client.tenant.create({
      data: { id: otherTenantId, name: 'Synthetic other tenant', slug: otherTenantId },
    })
    await client.venue.create({
      data: {
        id: `distribution-other-venue-${suffix}`,
        tenantId: otherTenantId,
        name: 'Synthetic same-slug venue',
        slug,
      },
    })
    await expect(
      resolveVenueDistribution({ client: client as never, venueSlug: slug, env }),
    ).resolves.toBeNull()
    const scoped = await resolveVenueDistribution({
      client: client as never,
      venueSlug: slug,
      venueTarget: { tenantId, venueId },
      env,
    })
    expect(scoped?.venueId).toBe(venueId)
    expect(scoped?.website.framed).toBe(true)
  })
})
