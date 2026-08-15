import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'test-key' },
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import { db } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { venueRouter } from './venue'

const integrationDescribe =
  process.env.RUN_VENUE_IMPORT_DB_INTEGRATION === '1' ? describe : describe.skip
const FAILURE_TITLE = '__pathfinder_atomic_import_failure__'

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for the venue import integration test')

  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error(
      'Venue import integration requires an exact-loopback pathfinder_disposable_* database',
    )
  }
}

integrationDescribe('venue content import (disposable PostgreSQL integration)', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const tenantId = `venue-import-tenant-${suffix}`
  const venueId = `c${suffix}`
  const testRouter = router({ venue: venueRouter })
  let disposableConfirmed = false

  function managerCtx(): TRPCContext {
    return {
      db,
      headers: new Headers(),
      session: {
        userId: 'venue-import-test-user',
        activeTenantId: tenantId,
        role: 'MANAGER',
        isPlatformAdmin: false,
      },
    }
  }

  beforeAll(async () => {
    assertDisposableDatabase()
    disposableConfirmed = true
    await db.tenant.create({
      data: { id: tenantId, name: 'Venue import integration fixture', slug: tenantId },
    })
    await db.venue.create({
      data: {
        id: venueId,
        tenantId,
        name: 'Venue import integration venue',
        slug: venueId,
        guideMode: 'non_location',
      },
    })
    await db.$executeRaw`
      CREATE OR REPLACE FUNCTION pathfinder_test_reject_atomic_import() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = '__pathfinder_atomic_import_failure__' THEN
          RAISE EXCEPTION 'deliberate venue import integration failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `
    await db.$executeRaw`
      DROP TRIGGER IF EXISTS pathfinder_test_reject_atomic_import ON venue_knowledge_entries
    `
    await db.$executeRaw`
      CREATE TRIGGER pathfinder_test_reject_atomic_import
        BEFORE INSERT ON venue_knowledge_entries
        FOR EACH ROW EXECUTE FUNCTION pathfinder_test_reject_atomic_import()
    `
  })

  afterAll(async () => {
    if (!disposableConfirmed) return
    await db.$executeRaw`
      DROP TRIGGER IF EXISTS pathfinder_test_reject_atomic_import ON venue_knowledge_entries
    `
    await db.$executeRaw`DROP FUNCTION IF EXISTS pathfinder_test_reject_atomic_import()`
    await db.venueContentImportReceipt.deleteMany({ where: { tenantId } })
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    // ContentVersion is append-only and restricts tenant deletion. The unique
    // test tenant is intentionally retained until the disposable database exits.
    await db.$disconnect()
  })

  it('commits both collections together on success', async () => {
    const caller = testRouter.createCaller(managerCtx())
    const input = {
      venueId,
      idempotencyKey: randomUUID(),
      places: [{ name: 'Successful place', type: 'room' }],
      knowledgeEntries: [{ title: 'Successful knowledge', category: 'FAQ', content: 'Details' }],
    }
    await expect(caller.venue.importContent(input)).resolves.toEqual({
      placeCount: 1,
      knowledgeEntryCount: 1,
      replayed: false,
    })

    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Successful place' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: 'Successful knowledge' } }),
        db.venueContentImportReceipt.count({ where: { tenantId, venueId } }),
        db.embeddingDispatch.count({ where: { tenantId, venueId } }),
      ]),
    ).resolves.toEqual([1, 1, 1, 2])

    await expect(caller.venue.importContent(input)).resolves.toEqual({
      placeCount: 1,
      knowledgeEntryCount: 1,
      replayed: true,
    })
    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Successful place' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: 'Successful knowledge' } }),
        db.venueContentImportReceipt.count({ where: { tenantId, venueId } }),
        db.embeddingDispatch.count({ where: { tenantId, venueId } }),
      ]),
    ).resolves.toEqual([1, 1, 1, 2])

    await expect(
      caller.venue.importContent({
        ...input,
        places: [{ name: 'Changed replay', type: 'room' }],
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('converges concurrent exact retries on one receipt and content set', async () => {
    const caller = testRouter.createCaller(managerCtx())
    const input = {
      venueId,
      idempotencyKey: randomUUID(),
      places: [{ name: 'Concurrent place', type: 'room' }],
      knowledgeEntries: [{ title: 'Concurrent knowledge', category: 'FAQ', content: 'Details' }],
    }

    const results = await Promise.all(
      Array.from({ length: 16 }, () => caller.venue.importContent(input)),
    )
    expect(results.filter((result) => !result.replayed)).toHaveLength(1)
    expect(results.filter((result) => result.replayed)).toHaveLength(15)
    expect(
      results.every((result) => result.placeCount === 1 && result.knowledgeEntryCount === 1),
    ).toBe(true)

    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Concurrent place' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: 'Concurrent knowledge' } }),
        db.venueContentImportReceipt.count({
          where: { tenantId, venueId, idempotencyKey: input.idempotencyKey },
        }),
      ]),
    ).resolves.toEqual([1, 1, 1])
  })

  it('rolls back the place when a later knowledge insert fails', async () => {
    const caller = testRouter.createCaller(managerCtx())
    const idempotencyKey = randomUUID()
    await expect(
      caller.venue.importContent({
        venueId,
        idempotencyKey,
        places: [{ name: 'Must roll back', type: 'room' }],
        knowledgeEntries: [{ title: FAILURE_TITLE, category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrow()

    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Must roll back' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: FAILURE_TITLE } }),
        db.venueContentImportReceipt.count({ where: { tenantId, venueId, idempotencyKey } }),
      ]),
    ).resolves.toEqual([0, 0, 0])

    await expect(
      caller.venue.importContent({
        venueId,
        idempotencyKey,
        places: [{ name: 'Recovered place', type: 'room' }],
        knowledgeEntries: [{ title: 'Recovered knowledge', category: 'FAQ', content: 'Details' }],
      }),
    ).resolves.toEqual({ placeCount: 1, knowledgeEntryCount: 1, replayed: false })
    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Recovered place' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: 'Recovered knowledge' } }),
        db.venueContentImportReceipt.count({ where: { tenantId, venueId, idempotencyKey } }),
      ]),
    ).resolves.toEqual([1, 1, 1])
  })
})
