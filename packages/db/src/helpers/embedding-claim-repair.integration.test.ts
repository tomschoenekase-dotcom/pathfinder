import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '../client'
import { buildKnowledgeEntryText, buildPlaceText } from './content-text'
import { repairCompleteClaimMissingVector } from './embedding-claim-repair'
import { embeddingSourceHash } from './embedding-identity'

const integrationDescribe =
  process.env.RUN_EMBEDDING_DB_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('complete embedding claim invariant repair (PostgreSQL integration)', () => {
  const suffix = randomUUID()
  const tenantId = `embedding-repair-tenant-${suffix}`
  const venueId = `embedding-repair-venue-${suffix}`
  const profile = 'test-provider:test-model:1536'
  const operator = { actorId: 'test-operator' }

  beforeAll(async () => {
    process.env.RAILWAY_ENVIRONMENT = 'staging'
    process.env.EMBEDDING_DISPATCH_ENABLED = 'false'
    await db.tenant.create({ data: { id: tenantId, name: 'Embedding repair', slug: tenantId } })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Embedding repair venue', slug: venueId },
    })
  })

  beforeEach(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    // ContentVersion is append-only and restricts tenant deletion. The unique
    // test tenant is intentionally retained until the disposable database exits.
    await db.$disconnect()
    delete process.env.RAILWAY_ENVIRONMENT
    delete process.env.EMBEDDING_DISPATCH_ENABLED
  })

  async function seedPlaceClaim(name: string) {
    const entityId = `place-${randomUUID()}`
    const place = await db.place.create({
      data: { id: entityId, tenantId, venueId, name, type: 'exhibit', tags: [] },
    })
    const claim = await db.embeddingWorkClaim.create({
      data: {
        id: randomUUID(),
        tenantId,
        venueId,
        entityType: 'PLACE',
        entityId,
        contentUpdatedAt: place.updatedAt,
        sourceHash: embeddingSourceHash('place', buildPlaceText(place)),
        embeddingProfile: profile,
        status: 'COMPLETE',
        completedAt: new Date(),
      },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId, venueId, entityId } })
    return { entityId, place, claim }
  }

  it('supersedes the exact broken place claim, dispatches, and audits atomically', async () => {
    const { entityId, claim } = await seedPlaceClaim('Repair target')
    const result = await repairCompleteClaimMissingVector({
      tenantId,
      venueId,
      entityType: 'PLACE',
      entityId,
      expectedProfile: profile,
      ...operator,
    })
    expect(result).toMatchObject({ state: 'repaired', claimId: claim.id, dispatchInserted: true })
    expect(
      await db.embeddingWorkClaim.findFirstOrThrow({ where: { id: claim.id, tenantId } }),
    ).toMatchObject({
      status: 'SUPERSEDED',
      completedAt: claim.completedAt,
      sourceHash: claim.sourceHash,
    })
    expect(
      await db.embeddingDispatch.findFirstOrThrow({ where: { tenantId, venueId, entityId } }),
    ).toMatchObject({ attempts: 0, leaseToken: null })
    expect(
      await db.auditLog.count({
        where: {
          tenantId,
          action: 'embedding.claim-invariant-repaired',
          targetId: claim.id,
        },
      }),
    ).toBe(1)
  })

  it('uses current metadata-only revision while preserving claim identity', async () => {
    const { entityId, claim } = await seedPlaceClaim('Metadata target')
    const current = await db.place.update({
      where: { id: entityId, tenantId },
      data: { photoUrl: 'https://example.test/photo.jpg' },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId, venueId, entityId } })
    await expect(
      repairCompleteClaimMissingVector({
        tenantId,
        venueId,
        entityType: 'PLACE',
        entityId,
        expectedProfile: profile,
        ...operator,
      }),
    ).resolves.toMatchObject({ state: 'repaired' })
    expect(
      await db.embeddingDispatch.findFirstOrThrow({ where: { tenantId, venueId, entityId } }),
    ).toMatchObject({ contentUpdatedAt: current.updatedAt })
    expect(
      await db.embeddingWorkClaim.findFirstOrThrow({ where: { id: claim.id, tenantId } }),
    ).toMatchObject({ contentUpdatedAt: claim.contentUpdatedAt, sourceHash: claim.sourceHash })
  })

  it('refuses a leased dispatch without changing the completed claim', async () => {
    const { entityId, place, claim } = await seedPlaceClaim('Leased target')
    await db.embeddingDispatch.create({
      data: {
        id: `place:${entityId}`,
        tenantId,
        venueId,
        entityType: 'PLACE',
        entityId,
        contentUpdatedAt: place.updatedAt,
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    })
    await expect(
      repairCompleteClaimMissingVector({
        tenantId,
        venueId,
        entityType: 'PLACE',
        entityId,
        expectedProfile: profile,
        ...operator,
      }),
    ).resolves.toEqual({ state: 'refused', reason: 'dispatch-conflict' })
    expect(
      await db.embeddingWorkClaim.findFirstOrThrow({ where: { id: claim.id, tenantId } }),
    ).toMatchObject({ status: 'COMPLETE' })
    expect(await db.auditLog.count({ where: { tenantId } })).toBe(0)
  })

  it('repairs a knowledge entry with the same fencing', async () => {
    const entityId = `knowledge-${randomUUID()}`
    const entry = await db.venueKnowledgeEntry.create({
      data: {
        id: entityId,
        tenantId,
        venueId,
        title: 'Repair knowledge',
        category: 'visitor-info',
        content: 'Current content',
      },
    })
    const claim = await db.embeddingWorkClaim.create({
      data: {
        id: randomUUID(),
        tenantId,
        venueId,
        entityType: 'KNOWLEDGE_ENTRY',
        entityId,
        contentUpdatedAt: entry.updatedAt,
        sourceHash: embeddingSourceHash('knowledge-entry', buildKnowledgeEntryText(entry)),
        embeddingProfile: profile,
        status: 'COMPLETE',
        completedAt: new Date(),
      },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId, venueId, entityId } })
    await expect(
      repairCompleteClaimMissingVector({
        tenantId,
        venueId,
        entityType: 'KNOWLEDGE_ENTRY',
        entityId,
        expectedProfile: profile,
        ...operator,
      }),
    ).resolves.toMatchObject({ state: 'repaired' })
    expect(
      await db.embeddingWorkClaim.findFirstOrThrow({ where: { id: claim.id, tenantId } }),
    ).toMatchObject({ status: 'SUPERSEDED' })
  })
})
