import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { db } from '../client'
import {
  acknowledgeEmbeddingDispatch,
  failEmbeddingDispatch,
  leaseEmbeddingDispatchBatch,
} from './embedding-dispatches'
import { insertEmbeddingFreshnessCanary } from './embedding-freshness-canary'

const integrationDescribe =
  process.env.RUN_EMBEDDING_DB_INTEGRATION === '1' ? describe : describe.skip

integrationDescribe('embedding dispatch outbox (PostgreSQL integration)', () => {
  const runId = randomUUID()
  const tenantId = `embedding-dispatch-tenant-${runId}`
  const venueId = `embedding-dispatch-venue-${runId}`
  const secondVenueId = `embedding-dispatch-venue-2-${runId}`

  beforeAll(async () => {
    await db.tenant.create({
      data: { id: tenantId, name: 'Embedding dispatch integration', slug: tenantId },
    })
    await db.venue.create({
      data: { id: venueId, tenantId, name: 'Embedding dispatch venue', slug: venueId },
    })
    await db.venue.create({
      data: {
        id: secondVenueId,
        tenantId,
        name: 'Second embedding dispatch venue',
        slug: secondVenueId,
      },
    })
  })

  beforeEach(async () => {
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
  })

  afterAll(async () => {
    await db.embeddingDispatch.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('atomically creates place intent and coalesces source edits to the newest revision', async () => {
    const placeId = `place-${randomUUID()}`
    const place = await db.place.create({
      data: {
        id: placeId,
        tenantId,
        venueId,
        name: 'Original',
        type: 'exhibit',
        tags: [],
      },
    })
    const initial = await db.embeddingDispatch.findFirstOrThrow({
      where: { tenantId, venueId, entityType: 'PLACE', entityId: placeId },
    })
    expect(initial).toMatchObject({
      contentUpdatedAt: place.updatedAt,
      attempts: 0,
      leaseToken: null,
      lastError: null,
    })

    const { dispatches, leaseToken } = await leaseEmbeddingDispatchBatch({ batchSize: 1 })
    expect(dispatches).toHaveLength(1)
    const updated = await db.place.update({
      where: { id: placeId, tenantId },
      data: { name: 'Newest' },
    })
    const coalesced = await db.embeddingDispatch.findFirstOrThrow({
      where: { tenantId, venueId, entityType: 'PLACE', entityId: placeId },
    })
    expect(coalesced).toMatchObject({
      contentUpdatedAt: updated.updatedAt,
      attempts: 0,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError: null,
    })
    await expect(
      acknowledgeEmbeddingDispatch({
        id: initial.id,
        tenantId,
        venueId,
        contentUpdatedAt: place.updatedAt,
        leaseToken,
      }),
    ).resolves.toBe(false)
  })

  it('does not regenerate intent for a vector-only update', async () => {
    const placeId = `place-${randomUUID()}`
    await db.place.create({
      data: { id: placeId, tenantId, venueId, name: 'Vector target', type: 'exhibit', tags: [] },
    })
    const { dispatches, leaseToken } = await leaseEmbeddingDispatchBatch({ batchSize: 1 })
    expect(dispatches).toHaveLength(1)

    await db.$executeRaw`
      UPDATE places SET embedding = NULL
      WHERE id = ${placeId} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
    `
    const unchanged = await db.embeddingDispatch.findFirstOrThrow({
      where: { tenantId, venueId, entityType: 'PLACE', entityId: placeId },
    })
    expect(unchanged.leaseToken).toBe(leaseToken)
    expect(unchanged.attempts).toBe(1)
  })

  it('carries pending intent across metadata-only revisions without creating new work', async () => {
    const placeId = `place-${randomUUID()}`
    await db.place.create({
      data: { id: placeId, tenantId, venueId, name: 'Metadata target', type: 'exhibit', tags: [] },
    })
    const { dispatches, leaseToken } = await leaseEmbeddingDispatchBatch({ batchSize: 1 })
    expect(dispatches).toHaveLength(1)

    await db.$executeRaw`
      UPDATE places
      SET photo_url = 'https://example.test/changed.jpg',
          updated_at = updated_at + INTERVAL '1 second'
      WHERE id = ${placeId} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
    `
    const carried = await db.embeddingDispatch.findFirstOrThrow({
      where: { tenantId, venueId, entityType: 'PLACE', entityId: placeId },
    })
    expect(carried.contentUpdatedAt.getTime()).toBeGreaterThan(
      dispatches[0]!.contentUpdatedAt.getTime(),
    )
    expect(carried).toMatchObject({ attempts: 0, leaseToken: null, leaseExpiresAt: null })
    expect(carried.leaseToken).not.toBe(leaseToken)

    await db.embeddingDispatch.deleteMany({ where: { id: carried.id, tenantId, venueId } })
    await db.$executeRaw`
      UPDATE places
      SET photo_url = 'https://example.test/changed-again.jpg',
          updated_at = updated_at + INTERVAL '1 second'
      WHERE id = ${placeId} AND tenant_id = ${tenantId} AND venue_id = ${venueId}
    `
    expect(await db.embeddingDispatch.count({ where: { tenantId, entityId: placeId } })).toBe(0)
  })

  it('moves pending intent to the new venue scope', async () => {
    const placeId = `place-${randomUUID()}`
    await db.place.create({
      data: { id: placeId, tenantId, venueId, name: 'Movable target', type: 'exhibit', tags: [] },
    })

    const moved = await db.place.update({
      where: { id: placeId, tenantId },
      data: { venueId: secondVenueId },
    })
    expect(
      await db.embeddingDispatch.count({ where: { tenantId, venueId, entityId: placeId } }),
    ).toBe(0)
    expect(
      await db.embeddingDispatch.findFirstOrThrow({
        where: { tenantId, venueId: secondVenueId, entityType: 'PLACE', entityId: placeId },
      }),
    ).toMatchObject({ contentUpdatedAt: moved.updatedAt })
  })

  it('creates knowledge intent, releases failed delivery, and deletes intent with the entity', async () => {
    const entryId = `entry-${randomUUID()}`
    const entry = await db.venueKnowledgeEntry.create({
      data: {
        id: entryId,
        tenantId,
        venueId,
        title: 'Policy',
        category: 'visitor-info',
        content: 'Original policy.',
        isEnabled: true,
      },
    })
    const { dispatches, leaseToken } = await leaseEmbeddingDispatchBatch({ batchSize: 1 })
    expect(dispatches).toHaveLength(1)
    await expect(
      failEmbeddingDispatch({
        id: dispatches[0]!.id,
        tenantId,
        venueId,
        contentUpdatedAt: entry.updatedAt,
        leaseToken,
        error: 'redis unavailable',
      }),
    ).resolves.toBe(true)
    expect(
      await db.embeddingDispatch.findFirstOrThrow({
        where: { tenantId, venueId, entityType: 'KNOWLEDGE_ENTRY', entityId: entryId },
      }),
    ).toMatchObject({ leaseToken: null, leaseExpiresAt: null, lastError: 'redis unavailable' })

    await db.venueKnowledgeEntry.deleteMany({ where: { id: entryId, tenantId } })
    expect(await db.embeddingDispatch.count({ where: { tenantId, entityId: entryId } })).toBe(0)
  })

  it('allows only one concurrent lease owner for one intent', async () => {
    const placeId = `place-${randomUUID()}`
    await db.place.create({
      data: { id: placeId, tenantId, venueId, name: 'Lease target', type: 'exhibit', tags: [] },
    })

    const batches = await Promise.all(
      Array.from({ length: 8 }, () => leaseEmbeddingDispatchBatch({ batchSize: 1 })),
    )
    expect(batches.flatMap((batch) => batch.dispatches)).toHaveLength(1)
    expect(
      new Set(batches.filter((batch) => batch.dispatches.length > 0).map((b) => b.leaseToken)).size,
    ).toBe(1)
  })

  it('leaves no intent when the content transaction rolls back', async () => {
    const placeId = `place-${randomUUID()}`
    await expect(
      db.$transaction(async (tx) => {
        await tx.place.create({
          data: { id: placeId, tenantId, venueId, name: 'Rolled back', type: 'exhibit', tags: [] },
        })
        throw new Error('rollback')
      }),
    ).rejects.toThrow('rollback')
    expect(await db.embeddingDispatch.count({ where: { tenantId, entityId: placeId } })).toBe(0)
  })

  it('inserts only an exact eligible canary and never resets an existing dispatch', async () => {
    const placeId = `place-${randomUUID()}`
    const place = await db.place.create({
      data: { id: placeId, tenantId, venueId, name: 'Canary target', type: 'exhibit', tags: [] },
    })
    await db.embeddingDispatch.deleteMany({ where: { tenantId, venueId, entityId: placeId } })

    await expect(
      insertEmbeddingFreshnessCanary({
        tenantId,
        venueId,
        targets: [{ entityType: 'PLACE', entityId: placeId, contentUpdatedAt: new Date(0) }],
      }),
    ).resolves.toEqual({ inserted: [], skipped: [placeId] })
    await expect(
      insertEmbeddingFreshnessCanary({
        tenantId,
        venueId,
        targets: [{ entityType: 'PLACE', entityId: placeId, contentUpdatedAt: place.updatedAt }],
      }),
    ).resolves.toEqual({ inserted: [placeId], skipped: [] })

    const { leaseToken } = await leaseEmbeddingDispatchBatch({ batchSize: 1 })
    await expect(
      insertEmbeddingFreshnessCanary({
        tenantId,
        venueId,
        targets: [{ entityType: 'PLACE', entityId: placeId, contentUpdatedAt: place.updatedAt }],
      }),
    ).resolves.toEqual({ inserted: [], skipped: [placeId] })
    expect(
      await db.embeddingDispatch.findFirstOrThrow({
        where: { tenantId, venueId, entityId: placeId },
      }),
    ).toMatchObject({ attempts: 1, leaseToken })
  })
})
