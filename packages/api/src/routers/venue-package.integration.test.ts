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
import type { VenuePackagePayloadV3, VenuePackageSourceProvenance } from '../schemas/venue-package'
import { knowledgeRouter } from './knowledge'
import { placeRouter } from './place'
import { venueRouter } from './venue'
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
  const testRouter = router({
    knowledge: knowledgeRouter,
    place: placeRouter,
    venue: venueRouter,
    venuePackage: venuePackageRouter,
  })
  let venueId = ''
  let concurrentVenueId = ''
  let failureVenueId = ''
  let serializedVenueId = ''
  let idempotentVenueId = ''
  let configVenueId = ''
  let settingsLockVenueId = ''

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

  function packageProvenance(label: string) {
    return {
      sourceType: 'INTEGRATION_FIXTURE',
      sourceName: label,
      sourceUrl: `https://example.invalid/pathfinder/${label.toLowerCase().replaceAll(' ', '-')}`,
      contentOrigin: 'HUMAN_AUTHORED' as const,
    }
  }

  async function applyVersionThree(targetVenueId: string, payload: VenuePackagePayloadV3) {
    const caller = testRouter.createCaller(ctx())
    const draft = await caller.venuePackage.createDraft({
      venueId: targetVenueId,
      payload,
      draftKey: randomUUID(),
    })
    expect(draft.preview.report.errors).toEqual([])
    expect(draft.preview.report.semanticDuplicateScan.status).toBe('COMPLETE')
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: draft.preview.warningDigest,
      acknowledgedPayloadHash: draft.payloadHash,
    })
    const applied = await caller.venuePackage.applyPackage({
      id: draft.id,
      expectedUpdatedAt: approved.updatedAt,
      commandKey: randomUUID(),
    })
    return { caller, draft, approved, applied }
  }

  function versionThreePlaceUpdatePayload(
    placeId: string,
    itemKey: string,
    name: string,
  ): VenuePackagePayloadV3 {
    return {
      schemaVersion: 3,
      places: {
        create: [],
        update: [
          {
            itemKey,
            provenance: packageProvenance(`${name} source`),
            id: placeId,
            value: {
              name,
              type: 'room',
              itemType: 'room',
              shortDescription: null,
              longDescription: null,
              lat: null,
              lng: null,
              tags: ['package'],
              importanceScore: 70,
              areaName: null,
              hours: '09:00-17:00',
              photoUrl: null,
              isActive: true,
            },
          },
        ],
        delete: [],
      },
      knowledgeEntries: { create: [], update: [], delete: [] },
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
    configVenueId = (await createVenue('Configuration venue')).id
    settingsLockVenueId = (await createVenue('Settings lock venue')).id
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

  it('applies and restores a versioned venue configuration without provider spend', async () => {
    const caller = testRouter.createCaller(ctx())
    const payload = {
      schemaVersion: 2 as const,
      venue: {
        identity: {
          name: 'Configuration venue refreshed',
          description: 'A portable venue identity patch.',
          category: 'museum',
        },
        guideNotes: 'Keep directions concise.',
        branding: {
          chatTheme: 'forest' as const,
          chatAccentColor: '#3A7BD5',
          chatFont: 'inter' as const,
          chatLogoUrl: 'https://example.invalid/pathfinder-logo.png',
          chatBannerUrl: null,
        },
        aiBehavior: {
          aiGuideNotes: 'Prefer accessible routes.',
          aiTone: 'PROFESSIONAL' as const,
          aiGuideName: 'Pip',
        },
      },
      places: [],
      knowledgeEntries: [],
    }
    await db.venue.updateMany({
      where: { id: configVenueId, tenantId },
      data: { chatBannerUrl: 'https://example.invalid/legacy-banner.png' },
    })
    const original = await db.venue.findFirstOrThrow({
      where: { id: configVenueId, tenantId },
    })
    const providerCallsBefore = vi.mocked(generateEmbeddings).mock.calls.length
    const preview = await caller.venuePackage.preview({ venueId: configVenueId, payload })
    expect(preview).toMatchObject({
      schemaVersion: 2,
      mode: 'CONFIG_PATCH_AND_ADDITIVE_V2',
      report: { errors: [], semanticDuplicateScan: { status: 'NOT_RUN' } },
      changes: {
        venue: {
          change: expect.arrayContaining([
            {
              path: 'venue.identity.name',
              before: original.name,
              after: payload.venue.identity.name,
            },
            {
              path: 'venue.branding.chatBannerUrl',
              before: original.chatBannerUrl,
              after: null,
            },
          ]),
        },
      },
    })

    const draft = await caller.venuePackage.createDraft({
      venueId: configVenueId,
      payload,
      draftKey: randomUUID(),
    })
    expect(vi.mocked(generateEmbeddings).mock.calls.length).toBe(providerCallsBefore)
    expect(draft.preview.report.semanticDuplicateScan).toMatchObject({
      status: 'COMPLETE',
      scopes: {
        places: { inputCount: 0, scannedInputCount: 0 },
        knowledgeEntries: { inputCount: 0, scannedInputCount: 0 },
      },
    })
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: draft.preview.warningDigest,
      acknowledgedPayloadHash: draft.payloadHash,
    })
    const applied = await caller.venuePackage.applyPackage({
      id: draft.id,
      expectedUpdatedAt: approved.updatedAt,
      commandKey: randomUUID(),
    })
    expect(applied.appliedEntities).toMatchObject({
      schemaVersion: 2,
      venue: {
        before: { name: original.name },
        after: { name: payload.venue.identity.name },
      },
      places: [],
      knowledgeEntries: [],
    })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: configVenueId, tenantId } }),
    ).resolves.toMatchObject({
      name: payload.venue.identity.name,
      description: payload.venue.identity.description,
      category: payload.venue.identity.category,
      guideNotes: payload.venue.guideNotes,
      chatTheme: payload.venue.branding.chatTheme,
      chatAccentColor: payload.venue.branding.chatAccentColor,
      chatFont: payload.venue.branding.chatFont,
      chatLogoUrl: payload.venue.branding.chatLogoUrl,
      chatBannerUrl: payload.venue.branding.chatBannerUrl,
      aiGuideNotes: payload.venue.aiBehavior.aiGuideNotes,
      aiTone: payload.venue.aiBehavior.aiTone,
      aiGuideName: payload.venue.aiBehavior.aiGuideName,
    })

    await caller.venuePackage.revertPackage({
      id: draft.id,
      expectedUpdatedAt: applied.updatedAt,
      commandKey: randomUUID(),
    })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: configVenueId, tenantId } }),
    ).resolves.toMatchObject({
      name: original.name,
      description: original.description,
      category: original.category,
      guideNotes: original.guideNotes,
      chatTheme: original.chatTheme,
      chatAccentColor: original.chatAccentColor,
      chatFont: original.chatFont,
      chatLogoUrl: original.chatLogoUrl,
      chatBannerUrl: original.chatBannerUrl,
      aiGuideNotes: original.aiGuideNotes,
      aiTone: original.aiTone,
      aiGuideName: original.aiGuideName,
    })
    const venueHistory = await db.contentVersion.findMany({
      where: {
        tenantId,
        venueId: configVenueId,
        entityType: 'VENUE',
        entityId: configVenueId,
        actorId,
      },
      select: { operation: true, beforeState: true, afterState: true, actorId: true },
      orderBy: { sequence: 'asc' },
    })
    expect(venueHistory).toHaveLength(2)
    expect(venueHistory).toEqual([
      expect.objectContaining({
        operation: 'UPDATE',
        actorId,
        beforeState: expect.objectContaining({ name: original.name }),
        afterState: expect.objectContaining({ name: payload.venue.identity.name }),
      }),
      expect.objectContaining({
        operation: 'UPDATE',
        actorId,
        beforeState: expect.objectContaining({ name: payload.venue.identity.name }),
        afterState: expect.objectContaining({ name: original.name }),
      }),
    ])

    await expect(caller.venue.delete({ id: configVenueId })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('dependent history'),
    })
    await expect(db.venue.count({ where: { id: configVenueId, tenantId } })).resolves.toBe(1)
  })

  it('atomically applies and exactly reverts a mixed V3 package with per-effect provenance', async () => {
    const targetVenue = await createVenue('Mixed V3 venue')
    const legacyReviewedAt = new Date('2026-07-01T12:00:00.000Z')
    const legacyProvenance = {
      sourceType: 'LEGACY_FIXTURE',
      authorship: 'HUMAN_AUTHORED',
      sourceName: 'Original curator notes',
      sourceUrl: 'https://example.invalid/pathfinder/original-curator-notes',
      importedAt: new Date('2026-06-30T12:00:00.000Z'),
      humanConfirmedAt: legacyReviewedAt,
      humanConfirmedBy: actorId,
      lastReviewedAt: legacyReviewedAt,
      lastReviewedBy: actorId,
    }
    const placeToUpdate = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Original update place',
        type: 'room',
        itemType: 'room',
        shortDescription: 'Original short description',
        longDescription: 'Original long description',
        lat: 41.1,
        lng: -87.1,
        tags: ['original'],
        importanceScore: 15,
        areaName: 'Original wing',
        hours: '09:00-17:00',
        photoUrl: 'https://example.invalid/original-place.png',
        ...legacyProvenance,
      },
    })
    const placeToDelete = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Original delete place',
        type: 'exhibit',
        tags: ['remove'],
        importanceScore: 10,
        ...legacyProvenance,
      },
    })
    const knowledgeToUpdate = await db.venueKnowledgeEntry.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        title: 'Original update knowledge',
        category: 'FAQ',
        content: 'Original update content.',
        isEnabled: true,
        ...legacyProvenance,
      },
    })
    const knowledgeToDelete = await db.venueKnowledgeEntry.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        title: 'Original delete knowledge',
        category: 'Policy',
        content: 'Original delete content.',
        isEnabled: false,
        ...legacyProvenance,
      },
    })
    const originalVenue = await db.venue.findFirstOrThrow({
      where: { id: targetVenue.id, tenantId },
    })
    const itemKeys = {
      placeCreate: '00000000-0000-4000-8000-000000000101',
      placeUpdate: '00000000-0000-4000-8000-000000000102',
      placeDelete: '00000000-0000-4000-8000-000000000103',
      knowledgeCreate: '00000000-0000-4000-8000-000000000104',
      knowledgeUpdate: '00000000-0000-4000-8000-000000000105',
      knowledgeDelete: '00000000-0000-4000-8000-000000000106',
    } as const
    const payload: VenuePackagePayloadV3 = {
      schemaVersion: 3,
      venue: { identity: { name: 'Mixed V3 venue refreshed' } },
      places: {
        create: [
          {
            itemKey: itemKeys.placeCreate,
            provenance: packageProvenance('Place create source'),
            value: {
              name: 'Created V3 place',
              type: 'amenity',
              itemType: 'amenity',
              tags: ['created'],
              importanceScore: 80,
            },
          },
        ],
        update: [
          {
            itemKey: itemKeys.placeUpdate,
            provenance: packageProvenance('Place update source'),
            id: placeToUpdate.id,
            value: {
              name: 'Updated V3 place',
              type: 'exhibit',
              itemType: 'exhibit',
              shortDescription: 'Updated short description',
              longDescription: 'Updated long description',
              lat: 42.2,
              lng: -88.2,
              tags: ['updated'],
              importanceScore: 95,
              areaName: 'Updated wing',
              hours: '10:00-18:00',
              photoUrl: 'https://example.invalid/updated-place.png',
              isActive: false,
            },
          },
        ],
        delete: [
          {
            itemKey: itemKeys.placeDelete,
            provenance: packageProvenance('Place delete source'),
            id: placeToDelete.id,
          },
        ],
      },
      knowledgeEntries: {
        create: [
          {
            itemKey: itemKeys.knowledgeCreate,
            provenance: packageProvenance('Knowledge create source'),
            value: {
              title: 'Created V3 knowledge',
              category: 'Accessibility',
              content: 'Created V3 content.',
              isEnabled: true,
            },
          },
        ],
        update: [
          {
            itemKey: itemKeys.knowledgeUpdate,
            provenance: packageProvenance('Knowledge update source'),
            id: knowledgeToUpdate.id,
            value: {
              title: 'Updated V3 knowledge',
              category: 'Directions',
              content: 'Updated V3 content.',
              isEnabled: false,
            },
          },
        ],
        delete: [
          {
            itemKey: itemKeys.knowledgeDelete,
            provenance: packageProvenance('Knowledge delete source'),
            id: knowledgeToDelete.id,
          },
        ],
      },
    }

    const { caller, approved, applied } = await applyVersionThree(targetVenue.id, payload)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedBy: actorId })
    const manifest = applied.appliedEntities as {
      schemaVersion: number
      rollbackContractVersion: number
      effects: Array<{
        itemKey: string
        entityType: string
        entityId: string
        operation: string
        applyVersionId: string
        beforeState: Record<string, unknown> | null
        afterState: Record<string, unknown> | null
      }>
    }
    expect(manifest).toMatchObject({ schemaVersion: 3, rollbackContractVersion: 2 })
    expect(manifest.effects).toHaveLength(7)
    expect(new Set(manifest.effects.map((effect) => effect.applyVersionId)).size).toBe(7)
    expect(new Set(manifest.effects.map((effect) => effect.itemKey)).size).toBe(7)

    const createdPlaceEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.placeCreate,
    )!
    const createdKnowledgeEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.knowledgeCreate,
    )!
    const updatedPlaceEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.placeUpdate,
    )!
    const deletedPlaceEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.placeDelete,
    )!
    const updatedKnowledgeEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.knowledgeUpdate,
    )!
    const deletedKnowledgeEffect = manifest.effects.find(
      (effect) => effect.itemKey === itemKeys.knowledgeDelete,
    )!
    await expect(
      db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
    ).resolves.toMatchObject({ name: payload.venue!.identity!.name })
    const updatedPlace = await db.place.findFirstOrThrow({
      where: { id: placeToUpdate.id, tenantId, venueId: targetVenue.id },
    })
    const expectedDirectProvenance = (provenance: VenuePackageSourceProvenance) => ({
      sourceType: provenance.sourceType,
      authorship: provenance.contentOrigin,
      sourceName: provenance.sourceName ?? null,
      sourceUrl: provenance.sourceUrl ?? null,
      importedAt: updatedPlace.importedAt,
      humanConfirmedAt: approved.approvedAt,
      humanConfirmedBy: actorId,
      lastReviewedAt: approved.approvedAt,
      lastReviewedBy: actorId,
      sourcePackageId: applied.id,
    })
    expect(updatedPlace).toMatchObject({
      ...payload.places.update[0]!.value,
      ...expectedDirectProvenance(payload.places.update[0]!.provenance),
    })
    expect(updatedPlace.importedAt).not.toBeNull()
    const createdPlace = await db.place.findFirstOrThrow({
      where: { id: createdPlaceEffect.entityId, tenantId },
    })
    expect(createdPlace).toMatchObject({
      name: payload.places.create[0]!.value.name,
      ...expectedDirectProvenance(payload.places.create[0]!.provenance),
    })
    const updatedKnowledge = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { id: knowledgeToUpdate.id, tenantId },
    })
    expect(updatedKnowledge).toMatchObject({
      ...payload.knowledgeEntries.update[0]!.value,
      ...expectedDirectProvenance(payload.knowledgeEntries.update[0]!.provenance),
    })
    const createdKnowledge = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { id: createdKnowledgeEffect.entityId, tenantId },
    })
    expect(createdKnowledge).toMatchObject({
      title: payload.knowledgeEntries.create[0]!.value.title,
      ...expectedDirectProvenance(payload.knowledgeEntries.create[0]!.provenance),
    })
    await expect(
      Promise.all([
        db.place.count({ where: { id: placeToDelete.id, tenantId } }),
        db.venueKnowledgeEntry.count({ where: { id: knowledgeToDelete.id, tenantId } }),
      ]),
    ).resolves.toEqual([0, 0])

    const applyVersions = await db.contentVersion.findMany({
      where: {
        tenantId,
        venueId: targetVenue.id,
        venuePackageId: applied.id,
        venuePackageAction: 'APPLY',
      },
      orderBy: { sequence: 'asc' },
    })
    expect(applyVersions).toHaveLength(7)
    const provenanceByItemKey = new Map<string, VenuePackageSourceProvenance>([
      [itemKeys.placeCreate, payload.places.create[0]!.provenance],
      [itemKeys.placeUpdate, payload.places.update[0]!.provenance],
      [itemKeys.placeDelete, payload.places.delete[0]!.provenance],
      [itemKeys.knowledgeCreate, payload.knowledgeEntries.create[0]!.provenance],
      [itemKeys.knowledgeUpdate, payload.knowledgeEntries.update[0]!.provenance],
      [itemKeys.knowledgeDelete, payload.knowledgeEntries.delete[0]!.provenance],
    ])
    for (const version of applyVersions) {
      const effect = manifest.effects.find((candidate) => candidate.applyVersionId === version.id)
      expect(effect).toBeDefined()
      const expectedSource = provenanceByItemKey.get(effect!.itemKey) ?? {
        sourceType: 'PATHFINDER_VENUE_PACKAGE',
        sourceName: `Venue package ${applied.id}`,
        contentOrigin: 'HUMAN_AUTHORED' as const,
      }
      expect(version).toMatchObject({
        entityType: effect!.entityType,
        entityId: effect!.entityId,
        operation: effect!.operation,
        venuePackageItemKey: effect!.itemKey,
        venuePackageAction: 'APPLY',
        sourceProvenance: {
          ...expectedSource,
          importedAt: updatedPlace.importedAt!.toISOString(),
          humanConfirmedAt: approved.approvedAt!.toISOString(),
          lastReviewedAt: approved.approvedAt!.toISOString(),
        },
      })
    }

    const reverted = await caller.venuePackage.revertPackage({
      id: applied.id,
      expectedUpdatedAt: applied.updatedAt,
      commandKey: randomUUID(),
    })
    expect(reverted).toMatchObject({ status: 'REVERTED', revertedBy: actorId })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
    ).resolves.toMatchObject({ name: originalVenue.name })
    const restoredPlaceToUpdate = await db.place.findFirstOrThrow({
      where: { id: placeToUpdate.id, tenantId },
    })
    const restoredPlaceToDelete = await db.place.findFirstOrThrow({
      where: { id: placeToDelete.id, tenantId },
    })
    const restoredKnowledgeToUpdate = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { id: knowledgeToUpdate.id, tenantId },
    })
    const restoredKnowledgeToDelete = await db.venueKnowledgeEntry.findFirstOrThrow({
      where: { id: knowledgeToDelete.id, tenantId },
    })
    expect(JSON.parse(JSON.stringify(restoredPlaceToUpdate))).toMatchObject(
      updatedPlaceEffect.beforeState!,
    )
    expect(JSON.parse(JSON.stringify(restoredPlaceToDelete))).toMatchObject(
      deletedPlaceEffect.beforeState!,
    )
    expect(JSON.parse(JSON.stringify(restoredKnowledgeToUpdate))).toMatchObject(
      updatedKnowledgeEffect.beforeState!,
    )
    expect(JSON.parse(JSON.stringify(restoredKnowledgeToDelete))).toMatchObject(
      deletedKnowledgeEffect.beforeState!,
    )
    await expect(
      Promise.all([
        db.place.count({ where: { id: createdPlaceEffect.entityId, tenantId } }),
        db.venueKnowledgeEntry.count({ where: { id: createdKnowledgeEffect.entityId, tenantId } }),
      ]),
    ).resolves.toEqual([0, 0])
    const revertVersions = await db.contentVersion.findMany({
      where: {
        tenantId,
        venueId: targetVenue.id,
        venuePackageId: applied.id,
        venuePackageAction: 'REVERT',
      },
    })
    expect(revertVersions).toHaveLength(7)
    expect(new Set(revertVersions.map((version) => version.revertedFromId))).toEqual(
      new Set(manifest.effects.map((effect) => effect.applyVersionId)),
    )
  })

  it('preserves a later disjoint field update while reverting a V3 package update', async () => {
    const targetVenue = await createVenue('Disjoint V3 venue')
    const original = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Disjoint original name',
        type: 'room',
        itemType: 'room',
        tags: ['original'],
        importanceScore: 20,
        hours: '09:00-17:00',
      },
    })
    const payload = versionThreePlaceUpdatePayload(
      original.id,
      '00000000-0000-4000-8000-000000000201',
      'Disjoint package name',
    )
    const { caller, applied } = await applyVersionThree(targetVenue.id, payload)

    await caller.place.update({ id: original.id, hours: 'Open late by manual review' })
    const manualVersion = await db.contentVersion.findFirstOrThrow({
      where: {
        tenantId,
        venueId: targetVenue.id,
        entityType: 'PLACE',
        entityId: original.id,
        venuePackageId: null,
      },
      orderBy: { sequence: 'desc' },
    })
    expect(manualVersion).toMatchObject({ operation: 'UPDATE', actorId })

    await caller.venuePackage.revertPackage({
      id: applied.id,
      expectedUpdatedAt: applied.updatedAt,
      commandKey: randomUUID(),
    })
    await expect(
      db.place.findFirstOrThrow({ where: { id: original.id, tenantId } }),
    ).resolves.toMatchObject({
      name: original.name,
      tags: original.tags,
      importanceScore: original.importanceScore,
      hours: 'Open late by manual review',
      sourceType: original.sourceType,
      authorship: original.authorship,
      sourcePackageId: original.sourcePackageId,
    })
    await expect(
      db.contentVersion.count({
        where: {
          tenantId,
          venueId: targetVenue.id,
          venuePackageId: applied.id,
          venuePackageAction: 'REVERT',
        },
      }),
    ).resolves.toBe(1)
  })

  it('preserves a later disjoint venue field while reverting a V3 venue patch', async () => {
    const targetVenue = await createVenue('Disjoint V3 venue settings')
    const payload: VenuePackagePayloadV3 = {
      schemaVersion: 3,
      venue: { identity: { name: 'Package venue name' } },
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    }
    const { caller, applied } = await applyVersionThree(targetVenue.id, payload)

    await caller.venue.update({
      id: targetVenue.id,
      description: 'Later manual description',
    })
    await caller.venuePackage.revertPackage({
      id: applied.id,
      expectedUpdatedAt: applied.updatedAt,
      commandKey: randomUUID(),
    })

    await expect(
      db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
    ).resolves.toMatchObject({
      name: targetVenue.name,
      description: 'Later manual description',
    })
  })

  it('reverts stacked V3 updates in reverse order without stranding the earlier package', async () => {
    const targetVenue = await createVenue('Stacked V3 venue')
    const original = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Stacked original name',
        type: 'room',
        itemType: 'room',
        tags: ['original'],
        importanceScore: 10,
        hours: '09:00-17:00',
      },
    })
    const packageA = await applyVersionThree(
      targetVenue.id,
      versionThreePlaceUpdatePayload(
        original.id,
        '00000000-0000-4000-8000-000000000211',
        'Stacked package A',
      ),
    )
    const packageB = await applyVersionThree(
      targetVenue.id,
      versionThreePlaceUpdatePayload(
        original.id,
        '00000000-0000-4000-8000-000000000212',
        'Stacked package B',
      ),
    )

    await packageB.caller.venuePackage.revertPackage({
      id: packageB.applied.id,
      expectedUpdatedAt: packageB.applied.updatedAt,
      commandKey: randomUUID(),
    })
    await packageA.caller.venuePackage.revertPackage({
      id: packageA.applied.id,
      expectedUpdatedAt: packageA.applied.updatedAt,
      commandKey: randomUUID(),
    })

    await expect(
      db.place.findFirstOrThrow({ where: { id: original.id, tenantId } }),
    ).resolves.toMatchObject({
      name: original.name,
      tags: original.tags,
      importanceScore: original.importanceScore,
      sourceType: original.sourceType,
      authorship: original.authorship,
      sourcePackageId: original.sourcePackageId,
    })
  })

  it('reverts disjoint stacked V3 venue packages in either order', async () => {
    const targetVenue = await createVenue('Disjoint stacked V3 venue')
    const packageA = await applyVersionThree(targetVenue.id, {
      schemaVersion: 3,
      venue: { identity: { name: 'Package A venue name' } },
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    })
    const packageB = await applyVersionThree(targetVenue.id, {
      schemaVersion: 3,
      venue: { guideNotes: 'Package B guide notes' },
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    })

    await packageA.caller.venuePackage.revertPackage({
      id: packageA.applied.id,
      expectedUpdatedAt: packageA.applied.updatedAt,
      commandKey: randomUUID(),
    })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
    ).resolves.toMatchObject({ name: targetVenue.name, guideNotes: 'Package B guide notes' })

    await packageB.caller.venuePackage.revertPackage({
      id: packageB.applied.id,
      expectedUpdatedAt: packageB.applied.updatedAt,
      commandKey: randomUUID(),
    })
    await expect(
      db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
    ).resolves.toMatchObject({ name: targetVenue.name, guideNotes: targetVenue.guideNotes })
  })

  it('reports retained place dependencies before a V3 delete can be approved', async () => {
    const targetVenue = await createVenue('Blocked V3 delete venue')
    const place = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Retained analytics place',
        type: 'room',
      },
    })
    await db.analyticsEvent.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        sessionId: `session-${randomUUID()}`,
        eventType: 'place_viewed',
        placeId: place.id,
        occurredAt: new Date(),
      },
    })
    const caller = testRouter.createCaller(ctx())
    const draft = await caller.venuePackage.createDraft({
      venueId: targetVenue.id,
      draftKey: randomUUID(),
      payload: {
        schemaVersion: 3,
        places: {
          create: [],
          update: [],
          delete: [
            {
              itemKey: '00000000-0000-4000-8000-000000000221',
              provenance: packageProvenance('Blocked delete source'),
              id: place.id,
            },
          ],
        },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
    })

    expect(draft.preview.report.errors).toEqual([
      expect.objectContaining({
        code: 'DELETE_BLOCKED',
        path: 'places.delete.0',
        message: expect.stringContaining('analytics-events (1)'),
      }),
    ])
    await expect(
      caller.venuePackage.approve({
        id: draft.id,
        expectedUpdatedAt: draft.updatedAt,
        commandKey: randomUUID(),
        acknowledgedWarningDigest: draft.preview.warningDigest,
        acknowledgedPayloadHash: draft.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('refuses to remove a package-created place after it gains a retained dependency', async () => {
    const targetVenue = await createVenue('Retained V3 create venue')
    const { caller, applied } = await applyVersionThree(targetVenue.id, {
      schemaVersion: 3,
      places: {
        create: [
          {
            itemKey: '00000000-0000-4000-8000-000000000222',
            provenance: packageProvenance('Retained create source'),
            value: {
              name: 'Later referenced place',
              type: 'room',
              tags: [],
              importanceScore: 0,
            },
          },
        ],
        update: [],
        delete: [],
      },
      knowledgeEntries: { create: [], update: [], delete: [] },
    })
    const manifest = applied.appliedEntities as {
      effects: Array<{ entityType: string; entityId: string }>
    }
    const placeId = manifest.effects.find((effect) => effect.entityType === 'PLACE')!.entityId
    await db.analyticsEvent.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        sessionId: `session-${randomUUID()}`,
        eventType: 'place_viewed',
        placeId,
        occurredAt: new Date(),
      },
    })

    await expect(
      caller.venuePackage.revertPackage({
        id: applied.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('retained dependencies'),
    })
    await expect(
      Promise.all([
        db.place.count({ where: { id: placeId, tenantId } }),
        db.contentVersion.count({
          where: {
            tenantId,
            venuePackageId: applied.id,
            venuePackageAction: 'REVERT',
          },
        }),
        db.venuePackage.count({ where: { id: applied.id, tenantId, status: 'APPLIED' } }),
      ]),
    ).resolves.toEqual([1, 0, 1])
  })

  it('rejects overlapping later changes before any V3 rollback write', async () => {
    const targetVenue = await createVenue('Overlap V3 venue')
    const original = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Overlap original name',
        type: 'room',
        itemType: 'room',
        tags: ['original'],
        importanceScore: 25,
        hours: '08:00-16:00',
      },
    })
    const payload = versionThreePlaceUpdatePayload(
      original.id,
      '00000000-0000-4000-8000-000000000301',
      'Overlap package name',
    )
    const { caller, applied } = await applyVersionThree(targetVenue.id, payload)
    await caller.place.update({ id: original.id, name: 'Later overlapping manual name' })
    const versionsBefore = await db.contentVersion.count({
      where: { tenantId, venueId: targetVenue.id, entityType: 'PLACE', entityId: original.id },
    })

    await expect(
      caller.venuePackage.revertPackage({
        id: applied.id,
        expectedUpdatedAt: applied.updatedAt,
        commandKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('conflicts with later content'),
    })
    await expect(
      db.place.findFirstOrThrow({ where: { id: original.id, tenantId } }),
    ).resolves.toMatchObject({ name: 'Later overlapping manual name' })
    await expect(
      Promise.all([
        db.contentVersion.count({
          where: { tenantId, venueId: targetVenue.id, entityType: 'PLACE', entityId: original.id },
        }),
        db.contentVersion.count({
          where: {
            tenantId,
            venueId: targetVenue.id,
            venuePackageId: applied.id,
            venuePackageAction: 'REVERT',
          },
        }),
        db.venuePackage.count({ where: { id: applied.id, tenantId, status: 'APPLIED' } }),
      ]),
    ).resolves.toEqual([versionsBefore, 0, 1])
  })

  it('serializes ordinary venue settings and deletion through the package content lock', async () => {
    const caller = testRouter.createCaller(ctx())
    let signalLockAcquired!: () => void
    let releaseLock!: () => void
    const lockAcquired = new Promise<void>((resolve) => {
      signalLockAcquired = resolve
    })
    const lockRelease = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const blocker = db.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, { tenantId, venueId: settingsLockVenueId })
      signalLockAcquired()
      await lockRelease
    })
    await lockAcquired

    let updateSettled = false
    const update = caller.venue
      .update({ id: settingsLockVenueId, name: 'Settings lock venue updated' })
      .finally(() => {
        updateSettled = true
      })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(updateSettled).toBe(false)
    releaseLock()
    await blocker
    await expect(update).resolves.toMatchObject({ name: 'Settings lock venue updated' })

    let signalDeleteLock!: () => void
    let releaseDeleteLock!: () => void
    const deleteLockAcquired = new Promise<void>((resolve) => {
      signalDeleteLock = resolve
    })
    const deleteLockRelease = new Promise<void>((resolve) => {
      releaseDeleteLock = resolve
    })
    const deleteBlocker = db.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, { tenantId, venueId: settingsLockVenueId })
      signalDeleteLock()
      await deleteLockRelease
    })
    await deleteLockAcquired

    let deleteSettled = false
    const deletion = caller.venue.delete({ id: settingsLockVenueId }).finally(() => {
      deleteSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(deleteSettled).toBe(false)
    releaseDeleteLock()
    await deleteBlocker
    await expect(deletion).resolves.toEqual({ id: settingsLockVenueId })
    await expect(db.venue.count({ where: { id: settingsLockVenueId, tenantId } })).resolves.toBe(0)
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

  it('rejects V3 ABA drift when content returns to the reviewed values with newer history', async () => {
    const targetVenue = await createVenue('V3 ABA venue')
    const original = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Reviewed place state',
        type: 'room',
        itemType: 'room',
        tags: ['reviewed'],
        importanceScore: 30,
      },
    })
    const caller = testRouter.createCaller(ctx())
    const payload = versionThreePlaceUpdatePayload(
      original.id,
      '00000000-0000-4000-8000-000000000401',
      'Package target state',
    )
    const draft = await caller.venuePackage.createDraft({
      venueId: targetVenue.id,
      payload,
      draftKey: randomUUID(),
    })
    if (draft.preview.schemaVersion !== 3) throw new Error('Expected a V3 preview')
    const reviewedVersionId = draft.preview.changes.places.change[0]?.expectedVersionId
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: draft.preview.warningDigest,
      acknowledgedPayloadHash: draft.payloadHash,
    })

    await caller.place.update({ id: original.id, name: 'Intervening place state' })
    await caller.place.update({ id: original.id, name: original.name })
    const latestVersion = await db.contentVersion.findFirstOrThrow({
      where: { tenantId, venueId: targetVenue.id, entityType: 'PLACE', entityId: original.id },
      orderBy: { sequence: 'desc' },
      select: { id: true },
    })
    expect(latestVersion.id).not.toBe(reviewedVersionId)

    await expect(
      caller.venuePackage.applyPackage({
        id: draft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('exact review plan changed'),
    })
    await expect(
      Promise.all([
        db.place.findFirstOrThrow({ where: { id: original.id, tenantId } }),
        db.contentVersion.count({
          where: {
            tenantId,
            venueId: targetVenue.id,
            venuePackageId: draft.id,
            venuePackageAction: 'APPLY',
          },
        }),
        db.venuePackage.count({ where: { id: draft.id, tenantId, status: 'APPROVED' } }),
      ]),
    ).resolves.toEqual([expect.objectContaining({ name: original.name }), 0, 1])
  })

  it('rejects V3 venue ABA drift after immutable review', async () => {
    const targetVenue = await createVenue('V3 venue ABA reviewed')
    const caller = testRouter.createCaller(ctx())
    const payload: VenuePackagePayloadV3 = {
      schemaVersion: 3,
      venue: { identity: { name: 'V3 venue package target' } },
      places: { create: [], update: [], delete: [] },
      knowledgeEntries: { create: [], update: [], delete: [] },
    }
    const draft = await caller.venuePackage.createDraft({
      venueId: targetVenue.id,
      payload,
      draftKey: randomUUID(),
    })
    if (draft.preview.schemaVersion !== 3) throw new Error('Expected a V3 preview')
    const reviewedVersionId = draft.preview.changes.venue.expectedVersionId
    expect(reviewedVersionId).toBeTruthy()
    const approved = await caller.venuePackage.approve({
      id: draft.id,
      expectedUpdatedAt: draft.updatedAt,
      commandKey: randomUUID(),
      acknowledgedWarningDigest: draft.preview.warningDigest,
      acknowledgedPayloadHash: draft.payloadHash,
    })

    await caller.venue.update({ id: targetVenue.id, name: 'V3 venue intervening state' })
    await caller.venue.update({ id: targetVenue.id, name: targetVenue.name })
    const latestVersion = await db.contentVersion.findFirstOrThrow({
      where: {
        tenantId,
        venueId: targetVenue.id,
        entityType: 'VENUE',
        entityId: targetVenue.id,
      },
      orderBy: { sequence: 'desc' },
      select: { id: true },
    })
    expect(latestVersion.id).not.toBe(reviewedVersionId)

    await expect(
      caller.venuePackage.applyPackage({
        id: draft.id,
        expectedUpdatedAt: approved.updatedAt,
        commandKey: randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('exact review plan changed'),
    })
    await expect(
      Promise.all([
        db.venue.findFirstOrThrow({ where: { id: targetVenue.id, tenantId } }),
        db.contentVersion.count({
          where: {
            tenantId,
            venueId: targetVenue.id,
            venuePackageId: draft.id,
            venuePackageAction: 'APPLY',
          },
        }),
        db.venuePackage.count({ where: { id: draft.id, tenantId, status: 'APPROVED' } }),
      ]),
    ).resolves.toEqual([expect.objectContaining({ name: targetVenue.name }), 0, 1])
  })

  it('enforces credential-free provenance URLs at the database boundary', async () => {
    const targetVenue = await createVenue('V3 provenance URL constraint venue')
    const place = await db.place.create({
      data: {
        tenantId,
        venueId: targetVenue.id,
        name: 'Provenance URL constraint place',
        type: 'room',
      },
    })

    for (const sourceUrl of [
      'https://example.test/source?sig=azure-sas-secret',
      'https://example.test/source#access_token=oauth-secret',
      'https://example.test/source?%73ig=encoded-secret',
      'https://example.test/source?access_%74oken=encoded-secret',
    ]) {
      await expect(
        db.$executeRaw`
          UPDATE places
          SET source_url = ${sourceUrl}
          WHERE id = ${place.id}
            AND tenant_id = ${tenantId}
            AND venue_id = ${targetVenue.id}
        `,
      ).rejects.toThrow(/places_provenance_shape_check|check constraint/iu)
    }
    await expect(
      db.place.findFirstOrThrow({ where: { id: place.id, tenantId }, select: { sourceUrl: true } }),
    ).resolves.toEqual({ sourceUrl: null })
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
