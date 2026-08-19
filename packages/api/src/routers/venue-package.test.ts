import { createHash } from 'node:crypto'
import { TRPCError } from '@trpc/server'
import { generateEmbeddings } from '@pathfinder/ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/config', () => ({
  logger: { error: vi.fn() },
}))

vi.mock('@pathfinder/ai', () => ({
  AI_EMBEDDING_MODEL_KEYS: {
    PLACE_CONTENT: 'place-content',
    KNOWLEDGE_CONTENT: 'knowledge-content',
  },
  AiGatewayError: class AiGatewayError extends Error {
    code = 'provider-error'
  },
  getAiEmbeddingProfile: (key: string) => `test-profile:${key}`,
  generateEmbeddings: vi.fn(async ({ texts, usageSink }) => {
    await usageSink({
      provider: 'test',
      model: 'test-embedding',
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
    return { embeddings: texts.map(() => Array(1_536).fill(0.01)) }
  }),
}))

vi.mock('@pathfinder/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@pathfinder/db')>()),
  assertGlobalAiAvailable: vi.fn().mockResolvedValue(undefined),
  buildKnowledgeEntryText: vi.fn((entry) => `${entry.title}\n${entry.content}`),
  buildPlaceText: vi.fn((place) => place.name),
  findVenuePackageKnowledgeSemanticDuplicates: vi.fn().mockResolvedValue([]),
  findVenuePackagePlaceSemanticDuplicates: vi.fn().mockResolvedValue([]),
  getVenuePackageSemanticCoverage: vi.fn().mockResolvedValue({
    places: {
      eligibleCount: 0,
      searchableCount: 0,
      missingVectorCount: 0,
      incompatibleVectorCount: 0,
    },
    knowledgeEntries: {
      eligibleCount: 0,
      searchableCount: 0,
      missingVectorCount: 0,
      incompatibleVectorCount: 0,
    },
  }),
  lockVenueContentMutation: vi.fn().mockResolvedValue(undefined),
  setContentVersionContext: vi.fn().mockResolvedValue(undefined),
  writeAuditLogStrict: vi.fn().mockResolvedValue(undefined),
}))

import {
  assertGlobalAiAvailable,
  getVenuePackageSemanticCoverage,
  setContentVersionContext,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../core'
import type { TRPCContext } from '../context'
import { canonicalVenuePackagePayload } from '../schemas/venue-package'
import {
  createVenuePackageDraftService,
  latestTargetVersions,
  venuePackageRouter,
} from './venue-package'

const venueFindFirst = vi.fn()
const venueUpdateMany = vi.fn()
const placeFindMany = vi.fn()
const placeCreateManyAndReturn = vi.fn()
const placeDeleteMany = vi.fn()
const knowledgeFindMany = vi.fn()
const knowledgeCreateManyAndReturn = vi.fn()
const knowledgeDeleteMany = vi.fn()
const packageFindFirst = vi.fn()
const packageFindMany = vi.fn()
const packageCreate = vi.fn()
const packageUpdateMany = vi.fn()
const analysisFindFirst = vi.fn()
const analysisCreate = vi.fn()
const analysisUpdateMany = vi.fn()
const aiUsageCreate = vi.fn()
const auditLogCreate = vi.fn()
const milestoneFindFirst = vi.fn()
const milestoneCreate = vi.fn()

const mockDb = {
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(mockDb)),
  $executeRaw: vi.fn(async () => 1),
  venue: { findFirst: venueFindFirst, updateMany: venueUpdateMany },
  place: {
    findMany: placeFindMany,
    createManyAndReturn: placeCreateManyAndReturn,
    deleteMany: placeDeleteMany,
  },
  venueKnowledgeEntry: {
    findMany: knowledgeFindMany,
    createManyAndReturn: knowledgeCreateManyAndReturn,
    deleteMany: knowledgeDeleteMany,
  },
  venuePackage: {
    findFirst: packageFindFirst,
    findMany: packageFindMany,
    create: packageCreate,
    updateMany: packageUpdateMany,
  },
  venuePackageDuplicateAnalysis: {
    findFirst: analysisFindFirst,
    create: analysisCreate,
    updateMany: analysisUpdateMany,
  },
  aiUsageEvent: { create: aiUsageCreate },
  onboardingMilestoneEvent: { findFirst: milestoneFindFirst, create: milestoneCreate },
  auditLog: { create: auditLogCreate },
} as unknown as TRPCContext['db']

const testRouter = router({ venuePackage: venuePackageRouter })
const venueId = 'cvenueabc123456789012'
const packageId = 'cpackageabc1234567890'
const updatedAt = new Date('2030-01-01T00:00:00.000Z')
const draftKey = '11111111-1111-4111-8111-111111111111'
const commandKey = '22222222-2222-4222-8222-222222222222'
const payload = {
  schemaVersion: 1 as const,
  places: [],
  knowledgeEntries: [
    { title: 'Accessibility', category: 'FAQ', content: 'Step-free entry.', isEnabled: true },
  ],
}

describe('bounded latest target version lookup', () => {
  it('aggregates latest sequences in the database and fetches only the bounded winners', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { entityType: 'PLACE', entityId: 'place_1', _max: { sequence: 11n } },
      { entityType: 'KNOWLEDGE_ENTRY', entityId: 'knowledge_1', _max: { sequence: 22n } },
    ])
    const findMany = vi.fn().mockResolvedValue([
      { id: 'version_1', entityType: 'PLACE', entityId: 'place_1' },
      { id: 'version_2', entityType: 'KNOWLEDGE_ENTRY', entityId: 'knowledge_1' },
    ])
    const result = await latestTargetVersions(
      { contentVersion: { groupBy, findMany } } as never,
      'tenant_1',
      venueId,
      ['place_1'],
      ['knowledge_1'],
      false,
    )
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['entityType', 'entityId'],
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId }),
        _max: { sequence: true },
      }),
    )
    expect(findMany).toHaveBeenCalledWith({
      where: { tenantId: 'tenant_1', venueId, sequence: { in: [11n, 22n] } },
      select: { id: true, entityType: true, entityId: true },
      take: 2,
    })
    expect([...result]).toEqual([
      ['PLACE:place_1', 'version_1'],
      ['KNOWLEDGE_ENTRY:knowledge_1', 'version_2'],
    ])
  })
})

const venueState = {
  id: venueId,
  name: 'Museum of Small Things',
  description: 'Original description',
  category: 'museum',
  guideNotes: 'Original guide notes',
  aiGuideNotes: 'Be concise.',
  aiTone: 'FRIENDLY',
  aiGuideName: 'Mina',
  chatTheme: 'default',
  chatAccentColor: '#112233',
  chatFont: 'jakarta',
  chatLogoUrl: null,
  chatBannerUrl: null,
  guideMode: 'non_location',
}

const venueSnapshot = {
  name: venueState.name,
  description: venueState.description,
  category: venueState.category,
  guideNotes: venueState.guideNotes,
  chatTheme: venueState.chatTheme,
  chatAccentColor: venueState.chatAccentColor,
  chatFont: venueState.chatFont,
  chatLogoUrl: venueState.chatLogoUrl,
  chatBannerUrl: venueState.chatBannerUrl,
  aiGuideNotes: venueState.aiGuideNotes,
  aiTone: venueState.aiTone,
  aiGuideName: venueState.aiGuideName,
}

const payloadV2 = {
  schemaVersion: 2 as const,
  venue: {
    identity: { name: 'Small Things Gallery' },
    branding: { chatAccentColor: '#A1B2C3', chatFont: 'jakarta' as const },
  },
  places: [],
  knowledgeEntries: [],
}

const venueSnapshotAfterV2 = {
  ...venueSnapshot,
  name: payloadV2.venue.identity.name,
  chatAccentColor: payloadV2.venue.branding.chatAccentColor,
}

function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const emptyBaseDigest = digest({ places: [], knowledgeEntries: [] })
const emptyWarningDigest = digest([])
const completeSemanticScan = {
  status: 'COMPLETE' as const,
  similarityThreshold: 0.86,
  scopes: {
    places: {
      embeddingProfile: 'test-profile:place-content',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    },
    knowledgeEntries: {
      embeddingProfile: 'test-profile:knowledge-content',
      inputCount: 1,
      scannedInputCount: 1,
      existingCount: 0,
      scannedExistingCount: 0,
    },
  },
}
const baseReport = { errors: [], warnings: [], semanticDuplicateScan: completeSemanticScan }
const basePreview = {
  schemaVersion: 1 as const,
  payloadHash: digest(canonicalVenuePackagePayload(venueId, payload)),
  baseDigest: emptyBaseDigest,
  mode: 'ADDITIVE_V1' as const,
  warningDigest: emptyWarningDigest,
  report: baseReport,
  changes: {
    places: { add: [], change: [], remove: [], unchanged: 0 },
    knowledgeEntries: {
      add: payload.knowledgeEntries,
      change: [],
      remove: [],
      unchanged: 0,
    },
  },
}
const basePackage = {
  id: packageId,
  tenantId: 'tenant_1',
  venueId,
  draftKey,
  schemaVersion: 1,
  payload,
  payloadHash: digest(canonicalVenuePackagePayload(venueId, payload)),
  baseDigest: emptyBaseDigest,
  validationReport: baseReport,
  previewPlan: basePreview,
  status: 'DRAFT' as const,
  createdBy: 'user_manager',
  approvedBy: null,
  approvedAt: null,
  approvedCommandKey: null,
  approvalWarningDigest: null,
  approvedWarningCodes: null,
  appliedBy: null,
  appliedAt: null,
  appliedCommandKey: null,
  appliedEntities: null,
  revertedBy: null,
  revertedAt: null,
  revertedCommandKey: null,
  createdAt: updatedAt,
  updatedAt,
}

const completeVenueOnlySemanticScan = {
  status: 'COMPLETE' as const,
  similarityThreshold: 0.86,
  scopes: {
    places: {
      embeddingProfile: 'test-profile:place-content',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    },
    knowledgeEntries: {
      embeddingProfile: 'test-profile:knowledge-content',
      inputCount: 0,
      scannedInputCount: 0,
      existingCount: 0,
      scannedExistingCount: 0,
    },
  },
}

const basePreviewV2 = {
  schemaVersion: 2 as const,
  payloadHash: digest(canonicalVenuePackagePayload(venueId, payloadV2)),
  baseDigest: digest({ venue: venueSnapshot, places: [], knowledgeEntries: [] }),
  mode: 'CONFIG_PATCH_AND_ADDITIVE_V2' as const,
  warningDigest: emptyWarningDigest,
  report: {
    errors: [],
    warnings: [],
    semanticDuplicateScan: completeVenueOnlySemanticScan,
  },
  changes: {
    venue: {
      change: [
        {
          path: 'venue.identity.name' as const,
          before: venueSnapshot.name,
          after: venueSnapshotAfterV2.name,
        },
        {
          path: 'venue.branding.chatAccentColor' as const,
          before: venueSnapshot.chatAccentColor,
          after: venueSnapshotAfterV2.chatAccentColor,
        },
      ],
      unchanged: 10,
    },
    places: { add: [], change: [], remove: [], unchanged: 0 },
    knowledgeEntries: { add: [], change: [], remove: [], unchanged: 0 },
  },
}

const basePackageV2 = {
  ...basePackage,
  schemaVersion: 2,
  payload: payloadV2,
  payloadHash: basePreviewV2.payloadHash,
  baseDigest: basePreviewV2.baseDigest,
  validationReport: basePreviewV2.report,
  previewPlan: basePreviewV2,
}

function context(role: 'STAFF' | 'MANAGER' | 'OWNER'): TRPCContext {
  return {
    db: mockDb,
    headers: new Headers(),
    session: {
      userId: `user_${role.toLowerCase()}`,
      activeTenantId: 'tenant_1',
      role,
      isPlatformAdmin: false,
    },
  }
}

describe('venue package router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    venueFindFirst.mockResolvedValue(venueState)
    venueUpdateMany.mockResolvedValue({ count: 1 })
    placeFindMany.mockResolvedValue([])
    knowledgeFindMany.mockResolvedValue([])
    packageFindFirst.mockResolvedValue(null)
    analysisFindFirst.mockResolvedValue(null)
    analysisCreate.mockResolvedValue({ id: 'analysis-1' })
    analysisUpdateMany.mockResolvedValue({ count: 1 })
    aiUsageCreate.mockResolvedValue({ id: 'usage-1' })
    milestoneFindFirst.mockResolvedValue(null)
    milestoneCreate.mockImplementation(async ({ data }) => data)
    placeDeleteMany.mockResolvedValue({ count: 0 })
    knowledgeDeleteMany.mockResolvedValue({ count: 0 })
  })

  it('denies STAFF preview before any database access', async () => {
    await expect(
      testRouter.createCaller(context('STAFF')).venuePackage.preview({ venueId, payload }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(venueFindFirst).not.toHaveBeenCalled()
  })

  it('denies STAFF draft creation before AI admission or database access', async () => {
    await expect(
      testRouter
        .createCaller(context('STAFF'))
        .venuePackage.createDraft({ venueId, payload, draftKey }),
    ).rejects.toThrowError(expect.objectContaining<Partial<TRPCError>>({ code: 'FORBIDDEN' }))
    expect(assertGlobalAiAvailable).not.toHaveBeenCalled()
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('fails closed on global AI admission before claiming a draft key', async () => {
    vi.mocked(assertGlobalAiAvailable).mockRejectedValueOnce(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'AI is unavailable' }),
    )

    await expect(
      testRouter
        .createCaller(context('OWNER'))
        .venuePackage.createDraft({ venueId, payload, draftKey }),
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
    expect(mockDb.$transaction).not.toHaveBeenCalled()
  })

  it('returns a server-authoritative additive preview with deterministic duplicate warnings', async () => {
    knowledgeFindMany.mockResolvedValueOnce([
      {
        id: 'cknowledgeabc123456789',
        title: '  ACCESSIBILITY ',
        category: 'FAQ',
        content: 'Existing',
        isEnabled: true,
      },
    ])
    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.preview({ venueId, payload })

    expect(result).toMatchObject({
      schemaVersion: 1,
      mode: 'ADDITIVE_V1',
      report: {
        errors: [],
        warnings: [
          expect.objectContaining({
            code: 'DUPLICATE_EXISTING_CONTENT',
            path: 'knowledgeEntries.0.title',
          }),
        ],
      },
      changes: { knowledgeEntries: { add: payload.knowledgeEntries, change: [], remove: [] } },
    })
    expect(packageCreate).not.toHaveBeenCalled()
  })

  it('returns a deterministic V2 venue patch preview with exact paths and venue-bound base state', async () => {
    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.preview({ venueId, payload: payloadV2 })

    expect(result).toEqual({
      ...basePreviewV2,
      report: {
        ...basePreviewV2.report,
        semanticDuplicateScan: expect.objectContaining({ status: 'NOT_RUN' }),
      },
    })
    expect(result.baseDigest).toBe(
      digest({ venue: venueSnapshot, places: [], knowledgeEntries: [] }),
    )
    expect(result.baseDigest).not.toBe(emptyBaseDigest)
    if (result.schemaVersion !== 2) throw new Error('Expected a schema-v2 preview')
    expect(result.changes.venue.change).toEqual(basePreviewV2.changes.venue.change)
  })

  it('records an actionable error and blocks approval for a V2 package with no effective changes', async () => {
    const noOpPayload = {
      schemaVersion: 2 as const,
      venue: { identity: { name: venueSnapshot.name } },
      places: [],
      knowledgeEntries: [],
    }
    const caller = testRouter.createCaller(context('OWNER'))
    const preview = await caller.venuePackage.preview({ venueId, payload: noOpPayload })
    expect(preview.report.errors).toEqual([
      expect.objectContaining({ code: 'NO_CHANGES', path: 'venue' }),
    ])
    const noOpPackage = {
      ...basePackageV2,
      payload: noOpPayload,
      payloadHash: preview.payloadHash,
      baseDigest: preview.baseDigest,
      validationReport: preview.report,
      previewPlan: preview,
    }
    packageFindFirst.mockResolvedValueOnce(noOpPackage).mockResolvedValueOnce(noOpPackage)

    await expect(
      caller.venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: preview.warningDigest,
        acknowledgedPayloadHash: preview.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('saves a venue-only V2 draft with complete semantic evidence and no provider call', async () => {
    analysisFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'analysis-1',
      payloadHash: basePackageV2.payloadHash,
      baseDigest: basePackageV2.baseDigest,
    })
    packageCreate.mockImplementationOnce(async ({ data }) => ({
      ...basePackageV2,
      validationReport: data.validationReport,
      previewPlan: data.previewPlan,
    }))

    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.createDraft({ venueId, payload: payloadV2, draftKey })

    expect(result).toMatchObject({ schemaVersion: 2, replayed: false })
    expect(result.preview.report.semanticDuplicateScan).toEqual(completeVenueOnlySemanticScan)
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(aiUsageCreate).not.toHaveBeenCalled()
    expect(analysisUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETE' }) }),
    )
  })

  it('persists a validated immutable draft and audits only the winning claim', async () => {
    analysisFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'analysis-1',
      payloadHash: basePackage.payloadHash,
      baseDigest: basePackage.baseDigest,
    })
    packageCreate.mockResolvedValueOnce(basePackage)

    const finalizer = vi.fn().mockResolvedValue({ attached: true })
    const orchestration = await createVenuePackageDraftService({
      db: mockDb,
      tenantId: 'tenant_1',
      actor: { type: 'HUMAN', id: 'user_1', role: 'OWNER' },
      input: { venueId, payload, draftKey },
      finalizer,
    })
    const result = orchestration.value

    expect(result).toMatchObject({ id: packageId, status: 'DRAFT', replayed: false })
    expect(orchestration.attachment).toEqual({ attached: true })
    expect(finalizer).toHaveBeenCalledWith(
      expect.objectContaining({
        packageId,
        status: 'DRAFT',
        replayed: false,
        preview: expect.objectContaining({
          report: expect.objectContaining({
            semanticDuplicateScan: expect.objectContaining({ status: 'COMPLETE' }),
          }),
        }),
      }),
    )
    expect(packageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId,
          schemaVersion: 1,
          baseDigest: emptyBaseDigest,
        }),
      }),
    )
    expect(setContentVersionContext).not.toHaveBeenCalled()
    expect(aiUsageCreate).toHaveBeenCalledOnce()
    expect(analysisUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETE' }) }),
    )
    expect(writeAuditLogStrict).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'venue-package.created-draft', targetId: packageId }),
      mockDb,
    )
  })

  it('terminally settles the semantic claim when an atomic attachment finalizer conflicts', async () => {
    analysisFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'analysis-1',
      payloadHash: basePackage.payloadHash,
      baseDigest: basePackage.baseDigest,
    })
    packageCreate.mockResolvedValueOnce(basePackage)
    const finalizer = vi
      .fn()
      .mockRejectedValue(new TRPCError({ code: 'CONFLICT', message: 'Support request changed' }))

    await expect(
      createVenuePackageDraftService({
        db: mockDb,
        tenantId: 'tenant_1',
        actor: { type: 'HUMAN', id: 'user_1', role: 'OWNER' },
        input: { venueId, payload, draftKey },
        finalizer,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(analysisUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'attachment-finalization-failed',
        }),
      }),
    )
  })

  it('returns an exact draft replay without coverage or provider work', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage)

    const result = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.createDraft({ venueId, payload, draftKey })

    expect(result).toMatchObject({ id: packageId, replayed: true, preview: basePreview })
    expect(getVenuePackageSemanticCoverage).not.toHaveBeenCalled()
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(analysisCreate).not.toHaveBeenCalled()
  })

  it('runs an explicit replay finalizer in the package transaction and returns its attachment', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage)
    const finalizer = vi.fn().mockResolvedValue({ linked: true })

    const result = await createVenuePackageDraftService({
      db: mockDb,
      tenantId: 'tenant_1',
      actor: { type: 'HUMAN', id: 'admin_1', role: 'PLATFORM_ADMIN' },
      input: { venueId, payload, draftKey },
      finalizer,
    })

    expect(result.value).toMatchObject({ id: packageId, replayed: true })
    expect(result.attachment).toEqual({ linked: true })
    expect(finalizer).toHaveBeenCalledWith(
      expect.objectContaining({ tx: mockDb, packageId, replayed: true }),
    )
    expect(getVenuePackageSemanticCoverage).not.toHaveBeenCalled()
    expect(generateEmbeddings).not.toHaveBeenCalled()
  })

  it('persists incomplete evidence without provider work and blocks approval', async () => {
    vi.mocked(getVenuePackageSemanticCoverage).mockResolvedValueOnce({
      places: {
        eligibleCount: 0,
        searchableCount: 0,
        missingVectorCount: 0,
        incompatibleVectorCount: 0,
      },
      knowledgeEntries: {
        eligibleCount: 1,
        searchableCount: 0,
        missingVectorCount: 1,
        incompatibleVectorCount: 0,
      },
    })
    packageCreate.mockImplementationOnce(async ({ data }) => ({
      ...basePackage,
      validationReport: data.validationReport,
      previewPlan: data.previewPlan,
    }))

    const draft = await testRouter
      .createCaller(context('MANAGER'))
      .venuePackage.createDraft({ venueId, payload, draftKey })

    expect(draft.preview.report.semanticDuplicateScan.status).toBe('INCOMPLETE')
    expect(draft.preview.report.errors).toEqual([
      expect.objectContaining({ code: 'SEMANTIC_SCAN_INCOMPLETE' }),
    ])
    expect(generateEmbeddings).not.toHaveBeenCalled()
    expect(analysisCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'COMPLETE' }) }),
    )

    const incompletePackage = {
      ...basePackage,
      validationReport: draft.preview.report,
      previewPlan: draft.preview,
    }
    packageFindFirst
      .mockResolvedValueOnce(incompletePackage)
      .mockResolvedValueOnce(incompletePackage)
    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: draft.preview.warningDigest,
        acknowledgedPayloadHash: draft.preview.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('fails closed when independent usage persistence fails', async () => {
    analysisFindFirst.mockResolvedValueOnce(null)
    aiUsageCreate.mockRejectedValueOnce(new Error('SECRET_SENTINEL database failure'))

    await expect(
      testRouter
        .createCaller(context('MANAGER'))
        .venuePackage.createDraft({ venueId, payload, draftKey }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Duplicate analysis could not complete; no draft was saved.',
    })
    expect(packageCreate).not.toHaveBeenCalled()
    expect(analysisUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          errorCode: 'usage-persistence-failed',
        }),
      }),
    )
    expect(JSON.stringify(analysisUpdateMany.mock.calls)).not.toContain('SECRET_SENTINEL')
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('blocks approval when venue content drifted after preview', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)
    placeFindMany.mockResolvedValueOnce([
      {
        id: 'cplaceabc123456789012',
        name: 'New row',
        type: 'room',
        itemType: null,
        shortDescription: null,
        longDescription: null,
        lat: null,
        lng: null,
        tags: [],
        importanceScore: 0,
        areaName: null,
        hours: null,
        photoUrl: null,
        isActive: true,
      },
    ])

    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: emptyWarningDigest,
        acknowledgedPayloadHash: basePackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('requires OWNER and a server-matching warning acknowledgement for approval', async () => {
    await expect(
      testRouter.createCaller(context('MANAGER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: '0'.repeat(64),
        acknowledgedPayloadHash: basePackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(packageFindFirst).not.toHaveBeenCalled()

    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)
    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: '0'.repeat(64),
        acknowledgedPayloadHash: basePackage.payloadHash,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('binds approval to the exact immutable payload hash shown to the owner', async () => {
    packageFindFirst.mockResolvedValueOnce(basePackage).mockResolvedValueOnce(basePackage)
    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.approve({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
        acknowledgedWarningDigest: emptyWarningDigest,
        acknowledgedPayloadHash: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })

  it('atomically applies an approved package and records a rollback manifest', async () => {
    const approved = {
      ...basePackage,
      status: 'APPROVED' as const,
      approvedBy: 'user_manager',
      approvedAt: updatedAt,
      approvedCommandKey: commandKey,
      approvalWarningDigest: emptyWarningDigest,
      approvedWarningCodes: [],
    }
    const created = { id: 'cknowledgeabc123456789', ...payload.knowledgeEntries[0]! }
    const postState = { places: [], knowledgeEntries: [created] }
    const applied = {
      ...approved,
      status: 'APPLIED' as const,
      appliedBy: 'user_manager',
      appliedAt: updatedAt,
      appliedEntities: {
        postApplyDigest: digest(postState),
        places: [],
        knowledgeEntries: [created],
      },
    }
    packageFindFirst
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(applied)
    knowledgeFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([created])
    knowledgeCreateManyAndReturn.mockResolvedValueOnce([created])
    packageUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(context('OWNER')).venuePackage.applyPackage({
      id: packageId,
      expectedUpdatedAt: updatedAt,
      commandKey,
    })

    expect(result.status).toBe('APPLIED')
    expect(knowledgeCreateManyAndReturn).toHaveBeenCalledOnce()
    expect(packageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPROVED', updatedAt }),
        data: expect.objectContaining({
          status: 'APPLIED',
          appliedEntities: expect.objectContaining({ postApplyDigest: digest(postState) }),
        }),
      }),
    )
    expect(auditLogCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'venue-package.applied' }),
    })
  })

  it('applies only changed supplied V2 venue fields and records an exact before/after manifest', async () => {
    const approved = {
      ...basePackageV2,
      status: 'APPROVED' as const,
      approvedBy: 'user_owner',
      approvedAt: updatedAt,
      approvedCommandKey: commandKey,
      approvalWarningDigest: emptyWarningDigest,
      approvedWarningCodes: [],
    }
    const postApplyDigest = digest({
      venue: venueSnapshotAfterV2,
      places: [],
      knowledgeEntries: [],
    })
    const appliedEntities = {
      schemaVersion: 2 as const,
      postApplyDigest,
      venue: { before: venueSnapshot, after: venueSnapshotAfterV2 },
      places: [],
      knowledgeEntries: [],
    }
    const applied = {
      ...approved,
      status: 'APPLIED' as const,
      appliedBy: 'user_owner',
      appliedAt: updatedAt,
      appliedCommandKey: commandKey,
      appliedEntities,
    }
    packageFindFirst
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(approved)
      .mockResolvedValueOnce(applied)
    venueFindFirst
      .mockResolvedValueOnce(venueState)
      .mockResolvedValueOnce(venueState)
      .mockResolvedValueOnce({
        ...venueState,
        name: venueSnapshotAfterV2.name,
        chatAccentColor: venueSnapshotAfterV2.chatAccentColor,
      })
      .mockResolvedValueOnce({
        ...venueState,
        name: venueSnapshotAfterV2.name,
        chatAccentColor: venueSnapshotAfterV2.chatAccentColor,
      })
    packageUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(context('OWNER')).venuePackage.applyPackage({
      id: packageId,
      expectedUpdatedAt: updatedAt,
      commandKey,
    })

    expect(result.status).toBe('APPLIED')
    expect(venueUpdateMany).toHaveBeenCalledWith({
      where: { id: venueId, tenantId: 'tenant_1' },
      data: { name: venueSnapshotAfterV2.name, chatAccentColor: '#A1B2C3' },
    })
    expect(venueUpdateMany.mock.calls[0]?.[0].data).not.toHaveProperty('chatFont')
    expect(packageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'APPLIED',
          appliedEntities,
        }),
      }),
    )
    expect(placeCreateManyAndReturn).not.toHaveBeenCalled()
    expect(knowledgeCreateManyAndReturn).not.toHaveBeenCalled()
  })

  it('reverts a V2 venue patch to its exact before snapshot', async () => {
    const postApplyDigest = digest({
      venue: venueSnapshotAfterV2,
      places: [],
      knowledgeEntries: [],
    })
    const appliedPackage = {
      ...basePackageV2,
      status: 'APPLIED' as const,
      approvedBy: 'user_owner',
      approvedAt: updatedAt,
      approvedCommandKey: commandKey,
      approvalWarningDigest: emptyWarningDigest,
      approvedWarningCodes: [],
      appliedBy: 'user_owner',
      appliedAt: updatedAt,
      appliedCommandKey: commandKey,
      appliedEntities: {
        schemaVersion: 2 as const,
        postApplyDigest,
        venue: { before: venueSnapshot, after: venueSnapshotAfterV2 },
        places: [],
        knowledgeEntries: [],
      },
    }
    const reverted = {
      ...appliedPackage,
      status: 'REVERTED' as const,
      revertedBy: 'user_owner',
      revertedAt: updatedAt,
      revertedCommandKey: commandKey,
    }
    packageFindFirst
      .mockResolvedValueOnce(appliedPackage)
      .mockResolvedValueOnce(appliedPackage)
      .mockResolvedValueOnce(appliedPackage)
      .mockResolvedValueOnce(appliedPackage)
      .mockResolvedValueOnce(reverted)
    venueFindFirst
      .mockResolvedValueOnce({
        ...venueState,
        name: venueSnapshotAfterV2.name,
        chatAccentColor: venueSnapshotAfterV2.chatAccentColor,
      })
      .mockResolvedValueOnce(venueState)
    packageUpdateMany.mockResolvedValueOnce({ count: 1 })

    const result = await testRouter.createCaller(context('OWNER')).venuePackage.revertPackage({
      id: packageId,
      expectedUpdatedAt: updatedAt,
      commandKey,
    })

    expect(result.status).toBe('REVERTED')
    expect(venueUpdateMany).toHaveBeenCalledWith({
      where: { id: venueId, tenantId: 'tenant_1' },
      data: venueSnapshot,
    })
    expect(packageUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'APPLIED', updatedAt }),
        data: expect.objectContaining({ status: 'REVERTED' }),
      }),
    )
  })

  it('rejects payload and rollback-manifest version mismatches before any write', async () => {
    const mismatchedV1 = {
      ...basePackage,
      status: 'APPLIED' as const,
      appliedEntities: {
        schemaVersion: 2,
        postApplyDigest: emptyBaseDigest,
        venue: null,
        places: [],
        knowledgeEntries: [],
      },
    }
    packageFindFirst.mockResolvedValueOnce(mismatchedV1).mockResolvedValueOnce(mismatchedV1)
    const caller = testRouter.createCaller(context('OWNER'))
    await expect(
      caller.venuePackage.revertPackage({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const mismatchedV2 = {
      ...basePackageV2,
      status: 'APPLIED' as const,
      appliedEntities: {
        postApplyDigest: basePackageV2.baseDigest,
        places: [],
        knowledgeEntries: [],
      },
    }
    packageFindFirst.mockResolvedValueOnce(mismatchedV2).mockResolvedValueOnce(mismatchedV2)
    await expect(
      caller.venuePackage.revertPackage({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    expect(knowledgeDeleteMany).not.toHaveBeenCalled()
    expect(placeDeleteMany).not.toHaveBeenCalled()
    expect(venueUpdateMany).not.toHaveBeenCalled()
    expect(packageUpdateMany).not.toHaveBeenCalled()
    expect(writeAuditLogStrict).not.toHaveBeenCalled()
  })

  it('refuses rollback after any venue-content drift and performs no delete', async () => {
    const appliedPackage = {
      ...basePackage,
      status: 'APPLIED',
      approvedBy: 'user_manager',
      approvedAt: updatedAt,
      appliedBy: 'user_manager',
      appliedAt: updatedAt,
      appliedCommandKey: commandKey,
      appliedEntities: {
        postApplyDigest: 'b'.repeat(64),
        places: [],
        knowledgeEntries: [],
      },
    }
    packageFindFirst.mockResolvedValueOnce(appliedPackage).mockResolvedValueOnce(appliedPackage)

    await expect(
      testRouter.createCaller(context('OWNER')).venuePackage.revertPackage({
        id: packageId,
        expectedUpdatedAt: updatedAt,
        commandKey,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(knowledgeDeleteMany).not.toHaveBeenCalled()
    expect(placeDeleteMany).not.toHaveBeenCalled()
    expect(packageUpdateMany).not.toHaveBeenCalled()
  })
})
