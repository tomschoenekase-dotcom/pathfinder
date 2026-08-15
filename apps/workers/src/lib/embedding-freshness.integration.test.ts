import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { db } from '@pathfinder/db'

import { auditEmbeddingFreshness } from './embedding-freshness'

const integrationDescribe =
  process.env.RUN_EMBEDDING_DB_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('embedding freshness audit (PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `freshness-tenant-${runId}`
  const otherTenantId = `freshness-other-${runId}`
  const venueId = `freshness-venue-${runId}`
  const secondVenueId = `freshness-venue-2-${runId}`
  const otherVenueId = `freshness-other-venue-${runId}`

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Freshness tenant', slug: tenantId },
        { id: otherTenantId, name: 'Other freshness tenant', slug: otherTenantId },
      ],
    })
    await db.venue.createMany({
      data: [
        { id: venueId, tenantId, name: 'Freshness venue', slug: venueId },
        { id: secondVenueId, tenantId, name: 'Second freshness venue', slug: secondVenueId },
        {
          id: otherVenueId,
          tenantId: otherTenantId,
          name: 'Other freshness venue',
          slug: otherVenueId,
        },
      ],
    })
    await db.place.createMany({
      data: [
        { id: `place-${runId}`, tenantId, venueId, name: 'Place', type: 'exhibit', tags: [] },
        {
          id: `place-2-${runId}`,
          tenantId,
          venueId: secondVenueId,
          name: 'Second place',
          type: 'exhibit',
          tags: [],
        },
        {
          id: `other-place-${runId}`,
          tenantId: otherTenantId,
          venueId: otherVenueId,
          name: 'Other place',
          type: 'exhibit',
          tags: [],
        },
      ],
    })
    await db.venueKnowledgeEntry.create({
      data: {
        id: `entry-${runId}`,
        tenantId,
        venueId,
        title: 'Policy',
        category: 'visitor-info',
        content: 'Policy text.',
      },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.embeddingDispatch.deleteMany({ where: { tenantId: otherTenantId } })
  })

  afterAll(async () => {
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.embeddingDispatch.deleteMany({ where: { tenantId: otherTenantId } })
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId } })
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId: otherTenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId: otherTenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId: otherTenantId } })
    // ContentVersion is append-only and restricts tenant deletion. The unique
    // test tenants are intentionally retained until the disposable database exits.
    await db.$disconnect()
  })

  it('is read-only and excludes other venues and tenants', async () => {
    const scoped = await auditEmbeddingFreshness({ tenantId, venueId })
    expect(scoped).toMatchObject({ scanned: 2, truncated: false })
    expect(scoped.actionableCandidates.map((candidate) => candidate.entityId).sort()).toEqual(
      [`entry-${runId}`, `place-${runId}`].sort(),
    )

    const tenantWide = await auditEmbeddingFreshness({ tenantId })
    expect(tenantWide.scanned).toBe(3)
    expect(
      tenantWide.actionableCandidates.some((candidate) =>
        candidate.entityId.startsWith('other-place-'),
      ),
    ).toBe(false)
    expect(await db.embeddingDispatch.count({ where: { tenantId } })).toBe(0)
    expect(await db.embeddingWorkClaim.count({ where: { tenantId } })).toBe(0)
  })
})
