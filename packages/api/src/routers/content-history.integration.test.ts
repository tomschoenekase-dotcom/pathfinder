import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PrismaClient } from '@prisma/client'

vi.mock('@pathfinder/config', () => ({
  env: { OPENAI_API_KEY: 'test-key' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('@pathfinder/analytics', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@pathfinder/jobs', () => ({ enqueueEmbedPlace: vi.fn().mockResolvedValue(undefined) }))

import { db, setContentVersionContext } from '@pathfinder/db'

import type { TRPCContext } from '../context'
import { router } from '../core'
import { contentHistoryRouter } from './content-history'
import { knowledgeRouter } from './knowledge'
import { placeRouter } from './place'
import { venueRouter } from './venue'

const integrationDescribe =
  process.env.RUN_CONTENT_HISTORY_DB_INTEGRATION === '1' ? describe : describe.skip
const editorDb = new PrismaClient()
const observerDb = new PrismaClient()

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for content-history integration')
  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error('Content-history integration requires an exact-loopback disposable database')
  }
}

async function waitForBlockedPlaceRowLock(): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const [state] = await observerDb.$queryRaw<Array<{ waiting: boolean }>>`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND wait_event_type = 'Lock'
          AND query LIKE '%FROM places%'
          AND query LIKE '%FOR UPDATE%'
      ) AS waiting
    `
    if (state?.waiting) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('Timed out waiting for the revert row lock')
}

integrationDescribe('content history (disposable PostgreSQL integration)', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const tenantId = `content-history-tenant-${suffix}`
  const otherTenantId = `content-history-other-${suffix}`
  const actorId = `content-history-user-${suffix}`
  const testRouter = router({
    venue: venueRouter,
    place: placeRouter,
    knowledge: knowledgeRouter,
    contentHistory: contentHistoryRouter,
  })
  let venueId = ''
  let placeId = ''
  let knowledgeId = ''

  function ctx(role: 'OWNER' | 'MANAGER' = 'OWNER', activeTenantId = tenantId): TRPCContext {
    return {
      db,
      headers: new Headers(),
      session: { userId: actorId, activeTenantId, role, isPlatformAdmin: false },
    }
  }

  beforeAll(async () => {
    assertDisposableDatabase()
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Content history tenant', slug: tenantId },
        { id: otherTenantId, name: 'Other history tenant', slug: otherTenantId },
      ],
    })

    const caller = testRouter.createCaller(ctx())
    const venue = await caller.venue.create({ name: 'Original venue', guideMode: 'non_location' })
    venueId = venue.id
    const place = await caller.place.create({
      venueId,
      name: 'Original place',
      type: 'exhibit',
      tags: [],
      importanceScore: 0,
    })
    placeId = place.id
    const knowledge = await caller.knowledge.create({
      venueId,
      title: 'Original answer',
      category: 'FAQ',
      content: 'Original content',
      isEnabled: true,
    })
    knowledgeId = knowledge.id
  })

  afterAll(async () => {
    await Promise.all([db.$disconnect(), editorDb.$disconnect(), observerDb.$disconnect()])
  })

  it('captures every entity create with the authenticated actor and monotonic sequence', async () => {
    const rows = await db.contentVersion.findMany({
      where: { tenantId },
      orderBy: { sequence: 'asc' },
    })
    expect(rows.map((row) => row.entityType)).toEqual(['VENUE', 'PLACE', 'KNOWLEDGE_ENTRY'])
    expect(rows.every((row) => row.operation === 'CREATE' && row.actorId === actorId)).toBe(true)
    expect(rows.every((row) => row.snapshotSchemaVersion === 1)).toBe(true)
    expect(rows[0]!.sequence < rows[1]!.sequence && rows[1]!.sequence < rows[2]!.sequence).toBe(
      true,
    )
  })

  it('ignores embedding-only writes but captures content updates', async () => {
    const beforeCount = await db.contentVersion.count({
      where: { tenantId, entityType: 'PLACE', entityId: placeId },
    })
    await db.$executeRaw`UPDATE places SET embedding = embedding WHERE id = ${placeId}`
    expect(
      await db.contentVersion.count({
        where: { tenantId, entityType: 'PLACE', entityId: placeId },
      }),
    ).toBe(beforeCount)

    await testRouter
      .createCaller(ctx('MANAGER'))
      .place.update({ id: placeId, name: 'Changed place' })
    const latest = await db.contentVersion.findFirstOrThrow({
      where: { tenantId, entityType: 'PLACE', entityId: placeId },
      orderBy: { sequence: 'desc' },
    })
    expect(latest).toMatchObject({ operation: 'UPDATE', actorId })
    expect(latest.beforeState).toMatchObject({ name: 'Original place' })
    expect(latest.afterState).toMatchObject({ name: 'Changed place' })
  })

  it('lists scoped history and reverts without overwriting a concurrent revision', async () => {
    const caller = testRouter.createCaller(ctx('MANAGER'))
    const initial = await caller.contentHistory.list({
      entityType: 'PLACE',
      entityId: placeId,
    })
    const original = initial.at(-1)!
    const current = initial[0]!

    const applied = await caller.contentHistory.revert({
      versionId: original.id,
      expectedCurrentVersionId: current.id,
    })
    expect(applied).toMatchObject({ revertedFromId: original.id, actorId })
    await expect(
      db.place.findFirstOrThrow({ where: { id: placeId, tenantId } }),
    ).resolves.toMatchObject({ name: 'Original place' })

    await caller.place.update({ id: placeId, name: 'Intervening edit' })
    await expect(
      caller.contentHistory.revert({
        versionId: original.id,
        expectedCurrentVersionId: applied.id,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('waits for an in-flight edit and rejects the now-stale revert', async () => {
    const caller = testRouter.createCaller(ctx('MANAGER'))
    const history = await caller.contentHistory.list({ entityType: 'PLACE', entityId: placeId })
    const target = history.at(-1)!
    const expectedCurrent = history[0]!
    let signalEditLocked!: () => void
    let releaseEdit!: () => void
    const editLocked = new Promise<void>((resolve) => {
      signalEditLocked = resolve
    })
    const editMayCommit = new Promise<void>((resolve) => {
      releaseEdit = resolve
    })

    const edit = editorDb.$transaction(
      async (tx) => {
        await setContentVersionContext(tx, { actorId })
        const updated = await tx.place.updateMany({
          where: { id: placeId, tenantId },
          data: { name: 'Concurrent edit' },
        })
        expect(updated.count).toBe(1)
        signalEditLocked()
        await editMayCommit
      },
      { timeout: 10_000 },
    )
    await editLocked

    let revertSettled = false
    const revert = caller.contentHistory
      .revert({
        versionId: target.id,
        expectedCurrentVersionId: expectedCurrent.id,
      })
      .finally(() => {
        revertSettled = true
      })
    await waitForBlockedPlaceRowLock()
    expect(revertSettled).toBe(false)
    releaseEdit()

    await edit
    await expect(revert).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      db.place.findFirstOrThrow({ where: { id: placeId, tenantId } }),
    ).resolves.toMatchObject({ name: 'Concurrent edit' })
    const latest = await db.contentVersion.findFirstOrThrow({
      where: { tenantId, entityType: 'PLACE', entityId: placeId },
      orderBy: { sequence: 'desc' },
    })
    expect(latest).toMatchObject({ operation: 'UPDATE', actorId })
    expect(latest.afterState).toMatchObject({ name: 'Concurrent edit' })
  }, 15_000)

  it('restores a deleted knowledge entry and keeps deletion in immutable history', async () => {
    const caller = testRouter.createCaller(ctx('MANAGER'))
    await caller.knowledge.delete({ id: knowledgeId })
    const deleted = (
      await caller.contentHistory.list({ entityType: 'KNOWLEDGE_ENTRY', entityId: knowledgeId })
    )[0]!
    expect(deleted.operation).toBe('DELETE')

    await caller.contentHistory.revert({
      versionId: deleted.id,
      expectedCurrentVersionId: deleted.id,
      snapshotSide: 'BEFORE',
    })
    await expect(
      db.venueKnowledgeEntry.findFirstOrThrow({ where: { id: knowledgeId, tenantId } }),
    ).resolves.toMatchObject({ title: 'Original answer', content: 'Original content' })
  })

  it('lists and restores a deleted venue from the tenant-level recovery feed', async () => {
    const owner = testRouter.createCaller(ctx('OWNER'))
    const deletedVenue = await owner.venue.create({
      name: 'Venue recovery fixture',
      guideMode: 'non_location',
    })
    await owner.venue.delete({ id: deletedVenue.id })

    const deletedVersion = (await owner.contentHistory.listDeletedVenues({ limit: 100 })).find(
      (version) => version.entityId === deletedVenue.id,
    )
    expect(deletedVersion).toMatchObject({ operation: 'DELETE' })

    const restoredVersion = await owner.contentHistory.revert({
      versionId: deletedVersion!.id,
      expectedCurrentVersionId: deletedVersion!.id,
      snapshotSide: 'BEFORE',
    })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: deletedVenue.id, tenantId } }),
    ).resolves.toMatchObject({ name: 'Venue recovery fixture' })

    await owner.place.create({
      venueId: deletedVenue.id,
      name: 'Dependent recovery fixture',
      type: 'exhibit',
      tags: [],
      importanceScore: 0,
    })
    await expect(
      owner.contentHistory.revert({
        versionId: deletedVersion!.id,
        expectedCurrentVersionId: restoredVersion.id,
        snapshotSide: 'AFTER',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Dependent records prevent restoring that historical deletion',
    })
  })

  it('captures the maximum 500-place plus 500-knowledge import atomically', async () => {
    const caller = testRouter.createCaller(ctx('MANAGER'))
    const importVenue = await testRouter.createCaller(ctx('OWNER')).venue.create({
      name: 'Maximum import history fixture',
      guideMode: 'non_location',
    })
    const result = await caller.venue.importContent({
      venueId: importVenue.id,
      idempotencyKey: randomUUID(),
      places: Array.from({ length: 500 }, (_, index) => ({
        name: `Imported place ${index}`,
        type: 'exhibit',
        tags: [],
        importanceScore: 0,
      })),
      knowledgeEntries: Array.from({ length: 500 }, (_, index) => ({
        title: `Imported answer ${index}`,
        category: 'FAQ',
        content: `Imported content ${index}`,
        isEnabled: true,
      })),
    })
    expect(result).toEqual({ placeCount: 500, knowledgeEntryCount: 500, replayed: false })
    await expect(
      db.contentVersion.count({
        where: {
          tenantId,
          venueId: importVenue.id,
          entityType: { in: ['PLACE', 'KNOWLEDGE_ENTRY'] },
          operation: 'CREATE',
          actorId,
        },
      }),
    ).resolves.toBe(1000)
  }, 30_000)

  it('denies cross-tenant reads/reverts and database mutation of history rows', async () => {
    const own = (
      await testRouter
        .createCaller(ctx('MANAGER'))
        .contentHistory.list({ entityType: 'VENUE', entityId: venueId })
    )[0]!
    const otherCaller = testRouter.createCaller(ctx('OWNER', otherTenantId))
    await expect(
      otherCaller.contentHistory.list({ entityType: 'VENUE', entityId: venueId }),
    ).resolves.toEqual([])
    await expect(
      otherCaller.contentHistory.revert({
        versionId: own.id,
        expectedCurrentVersionId: own.id,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await expect(
      db.contentVersion.updateMany({
        where: { id: own.id, tenantId },
        data: { actorId: 'tampered' },
      }),
    ).rejects.toThrow(/append-only/)
  })
})
