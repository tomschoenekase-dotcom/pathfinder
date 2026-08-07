import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '../client'
import { acquireEmbeddingWork, releaseEmbeddingWork } from './embedding-work-claims'
import {
  storeKnowledgeEntryEmbeddingForScope,
  storePlaceEmbeddingForScope,
} from './semantic-search'

const integrationDescribe =
  process.env.RUN_EMBEDDING_CLAIM_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('embedding work claims (PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `embedding-claim-tenant-${runId}`
  const venueId = `embedding-claim-venue-${runId}`
  const placeId = `embedding-claim-place-${runId}`
  const entryId = `embedding-claim-entry-${runId}`
  const vector = Array<number>(1_536).fill(0.001)
  let place: {
    updatedAt: Date
    name: string
    type: string
    itemType: string | null
    shortDescription: string | null
    longDescription: string | null
    tags: string[]
    areaName: string | null
    hours: string | null
    isActive: boolean
  }
  let entry: {
    updatedAt: Date
    title: string
    category: string
    content: string
    isEnabled: boolean
  }

  const placeIdentity = (leaseToken: string, overrides: Record<string, unknown> = {}) => ({
    tenantId,
    venueId,
    entityType: 'PLACE' as const,
    entityId: placeId,
    contentUpdatedAt: place.updatedAt,
    sourceHash: 'a'.repeat(64),
    embeddingProfile: 'openai:text-embedding-3-small:1536',
    leaseToken,
    ...overrides,
  })

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Embedding claim integration', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Embedding claim venue', slug: venueId },
    })
    place = await db.place.create({
      data: {
        id: placeId,
        tenantId,
        venueId,
        name: 'Test Place',
        type: 'exhibit',
        itemType: null,
        shortDescription: 'Short',
        longDescription: 'Long',
        tags: ['test', 'embedding'],
        areaName: 'North',
        hours: null,
        isActive: true,
      },
    })
    entry = await db.venueKnowledgeEntry.create({
      data: {
        id: entryId,
        tenantId,
        venueId,
        title: 'Test Entry',
        category: 'visitor-info',
        content: 'Test knowledge content',
        isEnabled: true,
      },
    })
  })

  beforeEach(async () => {
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId } })
    await db.$executeRaw`UPDATE places SET embedding = NULL WHERE id = ${placeId} AND tenant_id = ${tenantId}`
    await db.$executeRaw`UPDATE venue_knowledge_entries SET embedding = NULL WHERE id = ${entryId} AND tenant_id = ${tenantId}`
  })

  afterAll(async () => {
    await db.embeddingWorkClaim.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('grants exactly one of 32 concurrent callers and blocks a newer active revision', async () => {
    const results = await Promise.all(
      Array.from({ length: 32 }, () => acquireEmbeddingWork(placeIdentity(randomUUID()))),
    )

    expect(results.filter((result) => result.state === 'acquired')).toHaveLength(1)
    expect(results.filter((result) => result.state === 'leased')).toHaveLength(31)
    expect(await db.embeddingWorkClaim.count({ where: { tenantId, venueId } })).toBe(1)

    await expect(
      acquireEmbeddingWork(
        placeIdentity(randomUUID(), {
          contentUpdatedAt: new Date(place.updatedAt.getTime() + 1),
          sourceHash: 'b'.repeat(64),
        }),
      ),
    ).resolves.toEqual({ state: 'leased' })
  })

  it('takes over an expired lease, fences the stale owner, completes, and replays', async () => {
    const tokenA = randomUUID()
    const first = await acquireEmbeddingWork(placeIdentity(tokenA))
    expect(first.state).toBe('acquired')
    if (first.state !== 'acquired') throw new Error('Expected initial claim acquisition')

    await db.$executeRaw`
      UPDATE embedding_work_claims
      SET lease_expires_at = clock_timestamp() - INTERVAL '1 second'
      WHERE id = ${first.claimId} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
    `
    const tokenB = randomUUID()
    const second = await acquireEmbeddingWork(placeIdentity(tokenB))
    expect(second).toEqual({ state: 'acquired', claimId: first.claimId })
    if (second.state !== 'acquired') throw new Error('Expected expired claim takeover')

    const source = {
      name: place.name,
      type: place.type,
      itemType: place.itemType,
      shortDescription: place.shortDescription,
      longDescription: place.longDescription,
      tags: place.tags,
      areaName: place.areaName,
      hours: place.hours,
      isActive: place.isActive,
    }
    await expect(
      storePlaceEmbeddingForScope({
        placeId,
        tenantId,
        venueId,
        contentUpdatedAt: place.updatedAt,
        source,
        embedding: vector,
        claimId: first.claimId,
        leaseToken: tokenA,
      }),
    ).resolves.toEqual({ claimCompleted: false, stored: false })
    await expect(
      storePlaceEmbeddingForScope({
        placeId,
        tenantId,
        venueId,
        contentUpdatedAt: place.updatedAt,
        source,
        embedding: vector,
        claimId: second.claimId,
        leaseToken: tokenB,
      }),
    ).resolves.toEqual({ claimCompleted: true, stored: true })

    const completed = await db.embeddingWorkClaim.findFirstOrThrow({
      where: { id: second.claimId, tenantId, venueId },
    })
    expect(completed).toMatchObject({ status: 'COMPLETE', leaseToken: null, leaseExpiresAt: null })
    expect(completed.completedAt).not.toBeNull()
    await expect(acquireEmbeddingWork(placeIdentity(randomUUID()))).resolves.toEqual({
      state: 'complete',
    })
    await expect(
      acquireEmbeddingWork(
        placeIdentity(randomUUID(), {
          embeddingProfile: 'openai:text-embedding-3-large:3072',
        }),
      ),
    ).resolves.toMatchObject({ state: 'acquired', claimId: second.claimId })
    const vectorState = await db.$queryRaw<Array<{ stored: boolean }>>`
      SELECT embedding IS NOT NULL AS stored FROM places
      WHERE id = ${placeId} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
    `
    expect(vectorState).toEqual([{ stored: true }])
  })

  it('honors release tokens and reacquires after a scoped release', async () => {
    const token = randomUUID()
    const acquired = await acquireEmbeddingWork(placeIdentity(token))
    if (acquired.state !== 'acquired') throw new Error('Expected claim acquisition')

    await expect(
      releaseEmbeddingWork({ claimId: acquired.claimId, tenantId, venueId, leaseToken: 'wrong' }),
    ).resolves.toBe(false)
    await expect(
      releaseEmbeddingWork({ claimId: acquired.claimId, tenantId, venueId, leaseToken: token }),
    ).resolves.toBe(true)
    await expect(acquireEmbeddingWork(placeIdentity(randomUUID()))).resolves.toMatchObject({
      state: 'acquired',
    })
  })

  it('rolls back lease renewal when the vector write fails', async () => {
    const token = randomUUID()
    const acquired = await acquireEmbeddingWork(placeIdentity(token))
    if (acquired.state !== 'acquired') throw new Error('Expected claim acquisition')
    const before = await db.embeddingWorkClaim.findFirstOrThrow({
      where: { id: acquired.claimId, tenantId, venueId },
    })

    await expect(
      storePlaceEmbeddingForScope({
        placeId,
        tenantId,
        venueId,
        contentUpdatedAt: place.updatedAt,
        source: {
          name: place.name,
          type: place.type,
          itemType: place.itemType,
          shortDescription: place.shortDescription,
          longDescription: place.longDescription,
          tags: place.tags,
          areaName: place.areaName,
          hours: place.hours,
          isActive: place.isActive,
        },
        embedding: [1, 2],
        claimId: acquired.claimId,
        leaseToken: token,
      }),
    ).rejects.toThrow()
    const after = await db.embeddingWorkClaim.findFirstOrThrow({
      where: { id: acquired.claimId, tenantId, venueId },
    })
    expect(after).toMatchObject({ status: 'RUNNING', leaseToken: token, completedAt: null })
    expect(after.leaseExpiresAt?.getTime()).toBe(before.leaseExpiresAt?.getTime())
  })

  it('marks changed place source as superseded without storing a vector', async () => {
    const token = randomUUID()
    const acquired = await acquireEmbeddingWork(placeIdentity(token))
    if (acquired.state !== 'acquired') throw new Error('Expected claim acquisition')

    await db.place.update({
      where: { id: placeId, tenantId },
      data: { shortDescription: 'Changed after capture' },
    })
    await expect(
      storePlaceEmbeddingForScope({
        placeId,
        tenantId,
        venueId,
        contentUpdatedAt: place.updatedAt,
        source: {
          name: place.name,
          type: place.type,
          itemType: place.itemType,
          shortDescription: place.shortDescription,
          longDescription: place.longDescription,
          tags: place.tags,
          areaName: place.areaName,
          hours: place.hours,
          isActive: place.isActive,
        },
        embedding: vector,
        claimId: acquired.claimId,
        leaseToken: token,
      }),
    ).resolves.toEqual({ claimCompleted: true, stored: false })
    expect(
      await db.embeddingWorkClaim.findFirstOrThrow({
        where: { id: acquired.claimId, tenantId, venueId },
      }),
    ).toMatchObject({ status: 'SUPERSEDED', leaseToken: null, leaseExpiresAt: null })

    place = await db.place.update({
      where: { id: placeId, tenantId },
      data: { shortDescription: 'Short' },
    })
  })

  it('provides equivalent fenced storage for knowledge entries', async () => {
    const token = randomUUID()
    const acquired = await acquireEmbeddingWork({
      tenantId,
      venueId,
      entityType: 'KNOWLEDGE_ENTRY',
      entityId: entryId,
      contentUpdatedAt: entry.updatedAt,
      sourceHash: 'c'.repeat(64),
      embeddingProfile: 'openai:text-embedding-3-small:1536',
      leaseToken: token,
    })
    if (acquired.state !== 'acquired') throw new Error('Expected knowledge claim acquisition')

    await expect(
      storeKnowledgeEntryEmbeddingForScope({
        entryId,
        tenantId,
        venueId,
        contentUpdatedAt: entry.updatedAt,
        source: {
          title: entry.title,
          category: entry.category,
          content: entry.content,
          isEnabled: entry.isEnabled,
        },
        embedding: vector,
        claimId: acquired.claimId,
        leaseToken: token,
      }),
    ).resolves.toEqual({ claimCompleted: true, stored: true })
    await expect(
      storeKnowledgeEntryEmbeddingForScope({
        entryId,
        tenantId,
        venueId,
        contentUpdatedAt: entry.updatedAt,
        source: {
          title: entry.title,
          category: entry.category,
          content: entry.content,
          isEnabled: entry.isEnabled,
        },
        embedding: vector,
        claimId: acquired.claimId,
        leaseToken: token,
      }),
    ).resolves.toEqual({ claimCompleted: false, stored: false })
  })
})
