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
    await db.venueKnowledgeEntry.deleteMany({ where: { tenantId } })
    await db.place.deleteMany({ where: { tenantId } })
    await db.venue.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it('commits both collections together on success', async () => {
    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId,
        places: [{ name: 'Successful place', type: 'room' }],
        knowledgeEntries: [{ title: 'Successful knowledge', category: 'FAQ', content: 'Details' }],
      }),
    ).resolves.toEqual({ placeCount: 1, knowledgeEntryCount: 1 })

    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Successful place' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: 'Successful knowledge' } }),
      ]),
    ).resolves.toEqual([1, 1])
  })

  it('rolls back the place when a later knowledge insert fails', async () => {
    const caller = testRouter.createCaller(managerCtx())
    await expect(
      caller.venue.importContent({
        venueId,
        places: [{ name: 'Must roll back', type: 'room' }],
        knowledgeEntries: [{ title: FAILURE_TITLE, category: 'FAQ', content: 'Details' }],
      }),
    ).rejects.toThrow()

    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, name: 'Must roll back' } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, title: FAILURE_TITLE } }),
      ]),
    ).resolves.toEqual([0, 0])
  })
})
