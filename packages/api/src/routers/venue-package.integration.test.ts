import { createHash, randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: {
    PLACE_CONTENT: 'place-content',
    KNOWLEDGE_CONTENT: 'knowledge-content',
  },
  AiGatewayError: class AiGatewayError extends Error {
    code = 'provider-error'
  },
  getAiEmbeddingProfile: (key: string) => `integration-profile:${key}`,
  generateEmbeddings: vi.fn(async ({ texts, usageSink }) => {
    await usageSink({
      provider: 'integration-test',
      model: 'deterministic-embedding',
      pricingVersion: 'test-v1',
      usage: {
        inputTokens: texts.length,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
      estimatedCostUsd: 0,
      latencyMs: 1,
      attempts: 1,
      success: true,
    })
    return {
      embeddings: texts.map((text: string, textIndex: number) => {
        const vector = Array(1_536).fill(0)
        vector[(text.length + textIndex) % vector.length] = 1
        return vector
      }),
    }
  }),
}))

import { generateEmbeddings } from '@pathfinder/ai'

import { db, lockVenueContentMutation } from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { venuePackageRouter } from './venue-package'

const integrationDescribe =
  process.env.RUN_VENUE_PACKAGE_DB_INTEGRATION === '1' ? describe : describe.skip
const EMPTY_WARNING_DIGEST = createHash('sha256').update('[]').digest('hex')

function assertDisposableDatabase(): void {
  const rawUrl = process.env.DATABASE_URL
  if (!rawUrl) throw new Error('DATABASE_URL is required for venue-package integration')
  const url = new URL(rawUrl)
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
    !/^pathfinder_disposable_[a-z0-9_]+$/.test(database)
  ) {
    throw new Error('Venue-package integration requires an exact-loopback disposable database')
  }
}

integrationDescribe('venue packages (disposable PostgreSQL integration)', () => {
  const suffix = randomUUID().replaceAll('-', '')
  const tenantId = `venue-package-tenant-${suffix}`
  const otherTenantId = `venue-package-other-${suffix}`
  const actorId = `venue-package-user-${suffix}`
  const testRouter = router({ venuePackage: venuePackageRouter })
  let venueId = ''
  let concurrentVenueId = ''
  let failureVenueId = ''
  let serializedVenueId = ''
  let idempotentVenueId = ''

  function ctx(
    role: 'STAFF' | 'MANAGER' | 'OWNER' = 'OWNER',
    activeTenantId = tenantId,
  ): TRPCContext {
    return {
      db,
      headers: new Headers(),
      session: { userId: actorId, activeTenantId, role, isPlatformAdmin: false },
    }
  }

  async function createVenue(name: string) {
    return db.venue.create({
      data: {
        tenantId,
        name,
        slug: `${name.toLowerCase().replaceAll(' ', '-')}-${suffix}`,
        guideMode: 'non_location',
      },
    })
  }

  async function markCurrentKnowledgeSearchable(targetVenueId: string) {
    const entries = await db.venueKnowledgeEntry.findMany({
      where: { tenantId, venueId: targetVenueId, isEnabled: true },
      select: { id: true, updatedAt: true },
    })
    const vector = `[1,${Array(1_535).fill(0).join(',')}]`
    for (const entry of entries) {
      await db.$executeRaw`
        UPDATE venue_knowledge_entries
        SET embedding = ${vector}::vector(1536)
        WHERE id = ${entry.id}
          AND tenant_id = ${tenantId}
          AND venue_id = ${targetVenueId}
      `
      await db.embeddingWorkClaim.create({
        data: {
          id: randomUUID(),
          tenantId,
          venueId: targetVenueId,
          entityType: 'KNOWLEDGE_ENTRY',
          entityId: entry.id,
          contentUpdatedAt: entry.updatedAt,
          sourceHash: createHash('sha256').update(entry.id).digest('hex'),
          embeddingProfile: 'integration-profile:knowledge-content',
          status: 'COMPLETE',
          completedAt: new Date(),
        },
      })
    }
  }

  beforeAll(async () => {
    assertDisposableDatabase()
    await db.tenant.createMany({
      data: [
        { id: tenantId, name: 'Venue package tenant', slug: tenantId },
        { id: otherTenantId, name: 'Venue package other', slug: otherTenantId },
      ],
    })
    venueId = (await createVenue('Lifecycle venue')).id
    concurrentVenueId = (await createVenue('Concurrent venue')).id
    failureVenueId = (await createVenue('Failure venue')).id
    serializedVenueId = (await createVenue('Serialized venue')).id
    idempotentVenueId = (await createVenue('Idempotent venue')).id
  })

  afterAll(async () => {
    await db.$executeRaw`
      DROP TRIGGER IF EXISTS pathfinder_test_reject_venue_package ON venue_knowledge_entries
    `
    await db.$executeRaw`DROP FUNCTION IF EXISTS pathfinder_test_reject_venue_package()`
    await db.$disconnect()
  })

  it('previews without writes, replays a draft, applies atomically, and restores its exact base', async () => {
    const caller = testRouter.createCaller(ctx())
    const payload = {
      schemaVersion: 1 as const,
      places: [{ name: 'Package gallery', type: 'exhibit', tags: ['new'], importanceScore: 75 }],
      knowledgeEntries: [
        {
          title: 'Package accessibility',
          category: 'Accessibility',
          content: 'Step-free access is available.',
          isEnabled: true,
        },
      ],
    }

    const preview = await caller.venuePackage.preview({ venueId, payload })
    expect(preview).toMatchObject({
      mode: 'ADDITIVE_V1',
      report: {
        errors: [],
        warnings: [],
        semanticDuplicateScan: { status: 'NOT_RUN' },
      },
      changes: {
        places: { add: payload.places },
        knowledgeEntries: { add: payload.knowledgeEntries },
      },
    })
    await expect(
      Promise.all([
        db.venuePackage.count({ where: { tenantId, venueId } }),
        db.place.count({ where: { tenantId, venueId } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
      ]),
    ).resolves.toEqual([0, 0, 0])

    const draftKey = randomUUID()
    const draft = await caller.venuePackage.createDraft({ venueId, payload, draftKey })
    const providerCallsAfterDraft = vi.mocked(generateEmbeddings).mock.calls.length
    const replay = await caller.venuePackage.createDraft({ venueId, payload, draftKey })
    expect(draft).toMatchObject({ status: 'DRAFT', replayed: false })
    expect(replay).toMatchObject({ id: draft.id, status: 'DRAFT', replayed: true })
    expect(draft.preview.report.semanticDuplicateScan.status).toBe('COMPLETE')
    expect(draft.previewPlan).toEqual(draft.preview)
    expect(vi.mocked(generateEmbeddings).mock.calls.length).toBe(providerCallsAfterDraft)
    await expect(
      db.venuePackageDuplicateAnalysis.findFirst({
        where: { tenantId, venueId, draftKey },
      }),
    ).resolves.toMatchObject({ status: 'COMPLETE', draftId: draft.id })
    const storedAnalysis = await db.venuePackageDuplicateAnalysis.findFirstOrThrow({
      where: { tenantId, venueId, draftKey },
    })
    const emittedUsageEvents = await db.aiUsageEvent.findMany({
      where: {
        tenantId,
        venueId,
        feature: 'venue-package-duplicate-analysis',
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    expect(emittedUsageEvents).toHaveLength(2)
    expect(
      [...(storedAnalysis.usageEventIds as string[])].sort((left, right) =>
        left.localeCompare(right),
      ),
    ).toEqual(emittedUsageEvents.map(({ id }) => id))
    await expect(
      db.venuePackageDuplicateAnalysis.updateMany({
        where: { id: storedAnalysis.id, tenantId, venueId },
        data: { payloadHash: '0'.repeat(64) },
      }),
    ).rejects.toThrow(/identity is immutable/i)
    await expect(
      db.venuePackageDuplicateAnalysis.deleteMany({
        where: { id: storedAnalysis.id, tenantId, venueId },
      }),
    ).rejects.toThrow(/immutable evidence/i)
    await expect(db.$executeRaw`TRUNCATE TABLE venue_package_duplicate_analyses`).rejects.toThrow(
      /immutable evidence/i,
    )

    const approvalCommandKey = randomUUID()
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: approvalCommandKey,
      acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
      acknowledgedPayloadHash: draft.payloadHash,
    })
    await expect(
      caller.venuePackage.approve({
        id: draft.id,
        expectedUpdatedAt: draft.updatedAt,
        commandKey: approvalCommandKey,
        acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
        acknowledgedPayloadHash: draft.payloadHash,
      }),
    ).resolves.toMatchObject({ id: draft.id, status: 'APPROVED' })
    const applyCommandKey = randomUUID()
    const applied = await caller.venuePackage.applyPackage({
      id: draft.id,
      expectedUpdatedAt: approved.updatedAt,
      commandKey: applyCommandKey,
    })
    await expect(
      caller.venuePackage.applyPackage({
        id: draft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: applyCommandKey,
      }),
    ).resolves.toMatchObject({ id: draft.id, status: 'APPLIED' })
    expect(applied).toMatchObject({ status: 'APPLIED', appliedBy: actorId })
    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, venueId, name: 'Package gallery' } }),
        db.venueKnowledgeEntry.count({
          where: { tenantId, venueId, title: 'Package accessibility' },
        }),
        db.contentVersion.count({ where: { tenantId, venueId, actorId } }),
      ]),
    ).resolves.toEqual([1, 1, 2])

    const revertCommandKey = randomUUID()
    const reverted = await caller.venuePackage.revertPackage({
      id: draft.id,
      expectedUpdatedAt: applied.updatedAt,
      commandKey: revertCommandKey,
    })
    await expect(
      caller.venuePackage.revertPackage({
        id: draft.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: revertCommandKey,
      }),
    ).resolves.toMatchObject({ id: draft.id, status: 'REVERTED' })
    expect(reverted).toMatchObject({ status: 'REVERTED', revertedBy: actorId })
    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, venueId } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId } }),
        db.auditLog.count({ where: { tenantId, targetId: draft.id } }),
      ]),
    ).resolves.toEqual([0, 0, 4])

    const newRevision = await caller.venuePackage.createDraft({
      venueId,
      payload,
      draftKey: randomUUID(),
    })
    expect(newRevision).toMatchObject({ status: 'DRAFT', replayed: false })
    expect(newRevision.id).not.toBe(draft.id)
  })

  it('allows only one concurrent package application per venue', async () => {
    const caller = testRouter.createCaller(ctx())
    const payloads = ['Alpha', 'Beta'].map((label) => ({
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        { title: `${label} notice`, category: 'FAQ', content: `${label} content`, isEnabled: true },
      ],
    }))
    const drafts = await Promise.all(
      payloads.map((payload) =>
        caller.venuePackage.createDraft({
          venueId: concurrentVenueId,
          payload,
          draftKey: randomUUID(),
        }),
      ),
    )
    const approved = await Promise.all(
      drafts.map((draft) =>
        caller.venuePackage.approve({
          id: draft.id,
          expectedUpdatedAt: draft.updatedAt,
          commandKey: randomUUID(),
          acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
          acknowledgedPayloadHash: draft.payloadHash,
        }),
      ),
    )
    const results = await Promise.allSettled(
      approved.map((pkg) =>
        caller.venuePackage.applyPackage({
          id: pkg.id,
          expectedUpdatedAt: pkg.updatedAt,
          commandKey: randomUUID(),
        }),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await expect(
      Promise.all([
        db.venuePackage.count({
          where: { tenantId, venueId: concurrentVenueId, status: 'APPLIED' },
        }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId: concurrentVenueId } }),
      ]),
    ).resolves.toEqual([1, 1])

    // Production workers make newly applied content searchable asynchronously.
    // Complete that boundary explicitly before proving the next package revision.
    await markCurrentKnowledgeSearchable(concurrentVenueId)

    const nextPayload = {
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        { title: 'Gamma notice', category: 'FAQ', content: 'Gamma content', isEnabled: true },
      ],
    }
    const nextDraft = await caller.venuePackage.createDraft({
      venueId: concurrentVenueId,
      payload: nextPayload,
      draftKey: randomUUID(),
    })
    const nextApproved = await caller.venuePackage.approve({
      id: nextDraft.id,
      expectedUpdatedAt: nextDraft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
      acknowledgedPayloadHash: nextDraft.payloadHash,
    })
    await caller.venuePackage.applyPackage({
      id: nextDraft.id,
      expectedUpdatedAt: nextApproved.updatedAt,
      commandKey: randomUUID(),
    })
    await expect(
      Promise.all([
        db.venuePackage.count({
          where: { tenantId, venueId: concurrentVenueId, status: 'APPLIED' },
        }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId: concurrentVenueId } }),
      ]),
    ).resolves.toEqual([2, 2])
  })

  it('converges concurrent identical lifecycle command retries without duplicate writes', async () => {
    const caller = testRouter.createCaller(ctx())
    const payload = {
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        {
          title: 'Idempotent notice',
          category: 'FAQ',
          content: 'One authoritative row.',
          isEnabled: true,
        },
      ],
    }
    const draft = await caller.venuePackage.createDraft({
      venueId: idempotentVenueId,
      payload,
      draftKey: randomUUID(),
    })

    const approvalCommandKey = randomUUID()
    const approvals = await Promise.all(
      Array.from({ length: 8 }, () =>
        caller.venuePackage.approve({
          id: draft.id,
          expectedUpdatedAt: draft.updatedAt,
          commandKey: approvalCommandKey,
          acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
          acknowledgedPayloadHash: draft.payloadHash,
        }),
      ),
    )
    expect(new Set(approvals.map((pkg) => pkg.id))).toEqual(new Set([draft.id]))
    expect(approvals.every((pkg) => pkg.status === 'APPROVED')).toBe(true)

    const applyCommandKey = randomUUID()
    const applications = await Promise.all(
      Array.from({ length: 8 }, () =>
        caller.venuePackage.applyPackage({
          id: draft.id,
          expectedUpdatedAt: approvals[0]!.updatedAt,
          commandKey: applyCommandKey,
        }),
      ),
    )
    expect(applications.every((pkg) => pkg.status === 'APPLIED')).toBe(true)

    const revertCommandKey = randomUUID()
    const reversions = await Promise.all(
      Array.from({ length: 8 }, () =>
        caller.venuePackage.revertPackage({
          id: draft.id,
          expectedUpdatedAt: applications[0]!.updatedAt,
          commandKey: revertCommandKey,
        }),
      ),
    )
    expect(reversions.every((pkg) => pkg.status === 'REVERTED')).toBe(true)
    await expect(
      Promise.all([
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId: idempotentVenueId } }),
        db.venuePackage.count({
          where: { tenantId, venueId: idempotentVenueId, status: 'REVERTED' },
        }),
        db.auditLog.count({ where: { tenantId, targetId: draft.id } }),
      ]),
    ).resolves.toEqual([0, 1, 4])
  })

  it('waits for an ordinary venue-content writer and rejects the stale approved base', async () => {
    const caller = testRouter.createCaller(ctx())
    const payload = {
      schemaVersion: 1 as const,
      places: [],
      knowledgeEntries: [
        {
          title: 'Package notice',
          category: 'FAQ',
          content: 'Must not apply over a concurrent manual write.',
          isEnabled: true,
        },
      ],
    }
    const draft = await caller.venuePackage.createDraft({
      venueId: serializedVenueId,
      payload,
      draftKey: randomUUID(),
    })
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
      acknowledgedPayloadHash: draft.payloadHash,
    })

    let signalLockAcquired!: () => void
    let releaseWriter!: () => void
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve
    })
    const writerRelease = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const writer = db.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, { tenantId, venueId: serializedVenueId })
      await tx.place.create({
        data: {
          tenantId,
          venueId: serializedVenueId,
          name: 'Concurrent manual place',
          type: 'room',
          tags: [],
          importanceScore: 0,
        },
      })
      signalLockAcquired()
      await writerRelease
    })
    await lockAcquired

    let applicationSettled = false
    const application = caller.venuePackage
      .applyPackage({
        id: draft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => {
        applicationSettled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(applicationSettled).toBe(false)

    releaseWriter()
    await writer
    const result = await application
    expect(result.status).toBe('rejected')
    if (result.status === 'rejected') {
      expect(result.error).toMatchObject({ code: 'CONFLICT' })
    }
    await expect(
      Promise.all([
        db.venuePackage.count({
          where: { tenantId, venueId: serializedVenueId, status: 'APPROVED' },
        }),
        db.place.count({ where: { tenantId, venueId: serializedVenueId } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId: serializedVenueId } }),
      ]),
    ).resolves.toEqual([1, 1, 0])
  })

  it('rolls back every content and lifecycle write after a late provider-content failure', async () => {
    await db.$executeRaw`
      CREATE OR REPLACE FUNCTION pathfinder_test_reject_venue_package() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.title = '__pathfinder_venue_package_failure__' THEN
          RAISE EXCEPTION 'deliberate venue package failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `
    await db.$executeRaw`
      CREATE TRIGGER pathfinder_test_reject_venue_package
        BEFORE INSERT ON venue_knowledge_entries
        FOR EACH ROW EXECUTE FUNCTION pathfinder_test_reject_venue_package()
    `
    const caller = testRouter.createCaller(ctx())
    const payload = {
      schemaVersion: 1 as const,
      places: [{ name: 'Must roll back', type: 'room', tags: [], importanceScore: 0 }],
      knowledgeEntries: [
        {
          title: '__pathfinder_venue_package_failure__',
          category: 'FAQ',
          content: 'Failure fixture',
          isEnabled: true,
        },
      ],
    }
    const draft = await caller.venuePackage.createDraft({
      venueId: failureVenueId,
      payload,
      draftKey: randomUUID(),
    })
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: EMPTY_WARNING_DIGEST,
      acknowledgedPayloadHash: draft.payloadHash,
    })
    await expect(
      caller.venuePackage.applyPackage({
        id: draft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      }),
    ).rejects.toThrow()
    const readBack = await caller.venuePackage.getById({ id: draft.id })
    expect(readBack.status).toBe('APPROVED')
    await expect(
      Promise.all([
        db.place.count({ where: { tenantId, venueId: failureVenueId } }),
        db.venueKnowledgeEntry.count({ where: { tenantId, venueId: failureVenueId } }),
        db.auditLog.count({
          where: { tenantId, targetId: draft.id, action: 'venue-package.applied' },
        }),
      ]),
    ).resolves.toEqual([0, 0, 0])
  })

  it('denies cross-tenant reads and STAFF lifecycle access before writes', async () => {
    const own = await testRouter.createCaller(ctx()).venuePackage.list({ venueId })
    expect(own.length).toBeGreaterThan(0)
    await expect(
      testRouter
        .createCaller(ctx('MANAGER', otherTenantId))
        .venuePackage.getById({ id: own[0]!.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      testRouter.createCaller(ctx('STAFF')).venuePackage.list({ venueId }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
