import { TRPCError } from '@trpc/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bypass: vi.fn(async <T>(operation: () => Promise<T>) => operation()),
  runFindMany: vi.fn(),
  resultGroupBy: vi.fn(),
  resultFindMany: vi.fn(),
  reviewFindMany: vi.fn(),
  caseFindMany: vi.fn(),
  venuePackageFind: vi.fn(),
  createCase: vi.fn(),
  loadPreview: vi.fn(),
  createSnapshot: vi.fn(),
  createRun: vi.fn(),
  featureEnabled: vi.fn(),
  enqueueRun: vi.fn(),
  cancelRun: vi.fn(),
  durableEnabled: vi.fn(),
  regressionPolicy: vi.fn(),
  markQueued: vi.fn(),
  compareRuns: vi.fn(),
  appendReview: vi.fn(),
  nativeReleaseFind: vi.fn(),
  venueFind: vi.fn(),
  milestoneFindMany: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { EVALUATION_RUNNER_ENABLED: true } }))

vi.mock('@pathfinder/ai', () => ({
  AI_MODEL_KEYS: { GUEST_CHAT: 'guest-chat' },
  getAiModelSpec: () => ({ provider: 'anthropic', model: 'frozen-model', maxOutputTokens: 512 }),
}))

vi.mock('@pathfinder/jobs', () => ({ enqueueEvaluationRun: mocks.enqueueRun }))

vi.mock('../portal', () => ({ loadClientPreview: mocks.loadPreview }))

vi.mock('@pathfinder/db', () => ({
  EvaluationRunComparisonError: class EvaluationRunComparisonError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  EvaluationReviewActionError: class EvaluationReviewActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  withTenantIsolationBypass: mocks.bypass,
  compareEvaluationRuns: mocks.compareRuns,
  appendEvaluationReviewAction: mocks.appendReview,
  createOrReplayEvaluationCase: mocks.createCase,
  hashEvalCase: () => 'f'.repeat(64),
  evaluationSnapshotHash: () => '9'.repeat(64),
  createVenueContentSnapshot: mocks.createSnapshot,
  createOrReplayEvaluationRun: mocks.createRun,
  requestEvaluationRunCancellation: mocks.cancelRun,
  isEvaluationRuntimeDurablyEnabled: mocks.durableEnabled,
  getEvaluationRegressionAlertPolicy: mocks.regressionPolicy,
  markEvaluationRunQueued: mocks.markQueued,
  db: {
    $transaction: vi.fn(async (operation) =>
      operation({
        evalCase: { findMany: mocks.caseFindMany },
        venuePackage: { findFirst: mocks.venuePackageFind },
        tenantFeatureFlag: { findUnique: mocks.featureEnabled },
        nativeVenueDeploymentRelease: { findFirst: mocks.nativeReleaseFind },
      }),
    ),
    evalRun: { findMany: mocks.runFindMany },
    evalResult: { groupBy: mocks.resultGroupBy, findMany: mocks.resultFindMany },
    evalReview: { findMany: mocks.reviewFindMany },
    evalCase: { findMany: mocks.caseFindMany },
    venue: { findFirst: mocks.venueFind },
    onboardingMilestoneEvent: { findMany: mocks.milestoneFindMany },
    tenantFeatureFlag: { findUnique: mocks.featureEnabled },
  },
}))

import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminEvaluationOperationsRouter } from './evaluation-operations'

const testRouter = router({ evaluations: adminEvaluationOperationsRouter })

function context(isPlatformAdmin = true): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: {
      userId: 'operator_1',
      activeTenantId: 'tenant_other',
      role: 'STAFF',
      isPlatformAdmin,
    },
  }
}

describe('admin evaluation operations router', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runFindMany.mockResolvedValue([])
    mocks.resultFindMany.mockResolvedValue([])
    mocks.featureEnabled.mockResolvedValue(null)
    mocks.enqueueRun.mockResolvedValue({ enqueued: false })
    mocks.cancelRun.mockResolvedValue('requested')
    mocks.durableEnabled.mockResolvedValue(true)
    mocks.regressionPolicy.mockResolvedValue(null)
    mocks.markQueued.mockResolvedValue(true)
    mocks.venueFind.mockResolvedValue({ id: 'venue_1' })
    mocks.milestoneFindMany.mockResolvedValue([])
    mocks.compareRuns.mockResolvedValue({
      status: 'INCOMPARABLE',
      mismatchReasons: ['CONTENT'],
      cases: [],
      totals: null,
    })
  })

  it('returns a bounded, exact-scope onboarding milestone rollup with honest missing data', async () => {
    mocks.milestoneFindMany.mockResolvedValue([
      {
        id: 'event_2',
        eventType: 'FIRST_USEFUL_MATERIAL',
        occurredAt: new Date('2026-08-18T00:05:00.000Z'),
        category: 'PHOTO',
        durationMs: 300_000,
      },
      {
        id: 'event_1',
        eventType: 'INVITATION_STARTED',
        occurredAt: new Date('2026-08-18T00:00:00.000Z'),
        category: null,
        durationMs: null,
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .evaluations.getOnboardingMilestoneRollup({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        from: '2026-08-18T00:00:00.000Z',
        to: '2026-08-19T00:00:00.000Z',
      })
    expect(result.timeToFirstUsefulMaterial).toMatchObject({ valueMs: 300_000, denominator: 1 })
    expect(result.processingFailureRate).toMatchObject({ denominator: 1, rate: 0 })
    expect(result.clientQuestionResponse.responseRate).toMatchObject({ denominator: 0, rate: null })
    expect(mocks.milestoneFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
        take: 1001,
      }),
    )
  })

  it('prepares the seven versioned onboarding dimensions from one exact approved package', async () => {
    mocks.venuePackageFind.mockResolvedValue({ id: 'package_1', payloadHash: 'a'.repeat(64) })
    mocks.caseFindMany.mockResolvedValue([])
    mocks.loadPreview.mockResolvedValue({
      venue: { id: 'venue_1', name: 'Test Venue' },
      package: { id: 'package_1' },
      experience: {
        places: [{ name: 'Lobby' }],
        knowledgeEntries: [
          { title: 'Parking', category: 'arrival', content: 'Parking is beside the lobby.' },
        ],
      },
    })
    mocks.createCase.mockImplementation(async ({ caseId, identity }) => ({
      evalCase: {
        id: caseId,
        caseKey: identity.caseKey,
        revision: identity.revision,
        category: identity.category,
      },
      replayed: false,
    }))

    const result = await testRouter
      .createCaller(context())
      .evaluations.prepareOnboardingEvaluationSuite({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        packageId: 'package_1',
      })

    expect(result.cases).toHaveLength(7)
    expect(result.cases.map((item) => item.dimension)).toEqual([
      'fact',
      'navigation',
      'accessibility',
      'safety',
      'multilingual',
      'adversarial',
      'unanswerable',
    ])
    expect(mocks.loadPreview).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
      venueId: 'venue_1',
      packageId: 'package_1',
    })
    expect(mocks.createCase).toHaveBeenCalledTimes(7)
    expect(mocks.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          sourceType: 'ONBOARDING_APPROVED_PACKAGE',
          sourceRef: `venue-package:package_1:${'a'.repeat(64)}`,
          createdBy: 'operator_1',
        }),
      }),
    )
  })

  it('freezes server-derived identities as STAGED without publishing directly from the API', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    mocks.caseFindMany.mockResolvedValue([{ id: caseId, revision: 2, caseHash: 'b'.repeat(64) }])
    mocks.createSnapshot.mockResolvedValue({
      schemaVersion: 'pathfinder-venue-content-snapshot-v1',
      hash: 'c'.repeat(64),
      contentVersion: 9n,
      componentCounts: {
        venue: 1,
        places: 2,
        knowledgeEntries: 1,
        operationalUpdates: 0,
        universalRevisions: 3,
      },
      manifest: { tenantId: 'tenant_1', venueId: 'venue_1', frozen: true },
    })
    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'd'.repeat(64), status: 'STAGED' },
      replayed: false,
      identity,
    }))
    mocks.featureEnabled.mockResolvedValue({ enabled: true })
    mocks.enqueueRun.mockResolvedValue({ enqueued: true })

    const request = {
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      idempotencyKey: 'operator-request-1',
      caseIds: [caseId],
      budgetCeilingE8Usd: '1000',
    }
    const result = await testRouter
      .createCaller(context())
      .evaluations.requestEvaluationRun(request)

    expect(mocks.createSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', venueId: 'venue_1' }),
    )
    expect(mocks.caseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1', id: { in: [caseId] } },
      }),
    )
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          contentSnapshotHash: 'c'.repeat(64),
          contentSnapshotVersion: 9n,
          caseManifest: [{ caseId, revision: 2, caseHash: 'b'.repeat(64) }],
          modelName: 'frozen-model',
          runConfigSnapshot: expect.objectContaining({
            contentSnapshot: { tenantId: 'tenant_1', venueId: 'venue_1', frozen: true },
          }),
        }),
      }),
    )
    expect(mocks.enqueueRun).not.toHaveBeenCalled()
    expect(mocks.markQueued).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      enqueued: false,
      dispatchPending: true,
      executionDefaultOff: false,
      status: 'STAGED',
    })

    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'd'.repeat(64), status: 'COMPLETED' },
      replayed: true,
      identity,
    }))
    await expect(
      testRouter.createCaller(context()).evaluations.requestEvaluationRun(request),
    ).resolves.toMatchObject({
      replayed: true,
      dispatchPending: false,
      status: 'COMPLETED',
    })
  })

  it('freezes an exact prospective native release snapshot without reading current venue content', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    const releaseId = '22222222-2222-4222-8222-222222222222'
    mocks.caseFindMany.mockResolvedValue([{ id: caseId, revision: 1, caseHash: 'b'.repeat(64) }])
    mocks.featureEnabled.mockResolvedValue({ enabled: true })
    mocks.durableEnabled.mockResolvedValue(true)
    mocks.nativeReleaseFind.mockResolvedValue({
      id: releaseId,
      manifestHash: 'c'.repeat(64),
      desiredStateHash: 'd'.repeat(64),
      plan: {
        priorHead: null,
        desired: {
          venueBotConfiguration: {
            presentationMode: 'CLASSIC',
            personalityMode: 'PRESET',
            tonePreset: 'friendly',
            tonePresetVersion: 1,
            personalityProfileId: null,
            characterKey: null,
            customCharacterId: null,
            publicDisplayName: null,
            greeting: null,
            voiceProfileId: null,
          },
          venue: {
            name: 'Venue',
            slug: 'venue',
            description: null,
            guideNotes: null,
            aiGuideNotes: null,
            aiFeaturedPlaceId: null,
            aiTone: 'FRIENDLY',
            tonePreset: 'friendly',
            tonePresetVersion: 1,
            aiGuideName: null,
            chatTheme: 'default',
            chatAccentColor: null,
            chatFont: 'jakarta',
            chatLogoUrl: null,
            chatBannerUrl: null,
            category: null,
            guideMode: 'location_aware',
            defaultCenterLat: null,
            defaultCenterLng: null,
            geoBoundary: null,
            isActive: true,
          },
          places: [],
          knowledgeEntries: [],
          generalizedModules: [],
        },
      },
    })
    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'e'.repeat(64), status: 'STAGED' },
      replayed: false,
      identity,
    }))
    await testRouter.createCaller(context()).evaluations.requestEvaluationRun({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      idempotencyKey: 'native-1',
      caseIds: [caseId],
      budgetCeilingE8Usd: '1000',
      nativeReleaseId: releaseId,
    })
    expect(mocks.createSnapshot).not.toHaveBeenCalled()
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          contentSnapshotKind: 'NATIVE_CORE_V1',
          contentSnapshotRef: releaseId,
          contentSnapshotVersion: 1n,
          contentSnapshotHash: 'd'.repeat(64),
          packageSnapshotRef: `native-core-v1:${releaseId}`,
          packageSnapshotHash: 'c'.repeat(64),
          triggerType: 'ADMIN_NATIVE_RELEASE_REQUEST',
          runConfigSnapshot: expect.objectContaining({
            version: 'pathfinder-native-evaluation-run-config-v1',
            contentSnapshot: expect.objectContaining({ releaseId }),
          }),
        }),
      }),
    )
  })

  it('freezes an exact approved onboarding package instead of later live venue content', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    mocks.caseFindMany.mockResolvedValue([{ id: caseId, revision: 1, caseHash: 'b'.repeat(64) }])
    mocks.featureEnabled.mockResolvedValue({ enabled: true })
    mocks.venuePackageFind.mockResolvedValue({ id: 'package_1', payloadHash: 'c'.repeat(64) })
    mocks.loadPreview.mockResolvedValue({
      venue: { id: 'venue_1', name: 'Approved venue' },
      package: { id: 'package_1', status: 'APPROVED' },
      experience: {
        places: [],
        knowledgeEntries: [],
        summary: { placeCount: 0, knowledgeEntryCount: 0 },
      },
    })
    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'e'.repeat(64), status: 'STAGED' },
      replayed: false,
      identity,
    }))

    await testRouter.createCaller(context()).evaluations.requestEvaluationRun({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      idempotencyKey: 'approved-package-1',
      caseIds: [caseId],
      budgetCeilingE8Usd: '1000',
      approvedPackageId: 'package_1',
    })

    expect(mocks.createSnapshot).not.toHaveBeenCalled()
    expect(mocks.loadPreview).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
      venueId: 'venue_1',
      packageId: 'package_1',
    })
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          contentSnapshotKind: 'APPROVED_VENUE_PACKAGE_V1',
          contentSnapshotRef: 'package_1',
          contentSnapshotVersion: 1n,
          packageSnapshotRef: 'venue-package-v1:package_1',
          packageSnapshotHash: 'c'.repeat(64),
          triggerType: 'ADMIN_APPROVED_PACKAGE_REQUEST',
          runConfigSnapshot: expect.objectContaining({
            version: 'pathfinder-approved-package-evaluation-run-config-v1',
            contentSnapshot: expect.objectContaining({ packageId: 'package_1' }),
          }),
        }),
      }),
    )
  })

  it('rejects dark admission before creating a run identity', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    await expect(
      testRouter.createCaller(context()).evaluations.requestEvaluationRun({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        idempotencyKey: 'dark-request',
        caseIds: [caseId],
        budgetCeilingE8Usd: '1',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.createRun).not.toHaveBeenCalled()
    expect(mocks.enqueueRun).not.toHaveBeenCalled()
  })

  it('lists only safe scoped case fields with dark readiness and pagination', async () => {
    const createdAt = new Date('2026-08-11T12:00:00Z')
    mocks.caseFindMany.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        caseKey: 'known',
        revision: 1,
        category: 'known-answer',
        schemaVersion: 'v1',
        sourceType: 'CURATED',
        createdAt,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        caseKey: 'other',
        revision: 1,
        category: 'unknown-answer',
        schemaVersion: 'v1',
        sourceType: 'CURATED',
        createdAt,
      },
    ])
    const result = await testRouter
      .createCaller(context())
      .evaluations.listEvaluationCases({ tenantId: 'tenant_1', venueId: 'venue_1', limit: 1 })
    expect(result).toMatchObject({
      runnerEnabled: false,
      readiness: {
        apiProcessEnabled: true,
        durableGlobalEnabled: true,
        tenantEnabled: false,
      },
      regressionAlerts: {
        configured: false,
        minimumPassRateDrop: null,
        errorPassRateDrop: null,
      },
      maximumCases: 50,
      maximumBudgetE8Usd: '100000000',
      items: [{ caseKey: 'known' }],
    })
    expect(mocks.caseFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
        take: 2,
        select: expect.not.objectContaining({
          caseSnapshot: expect.anything(),
          caseHash: expect.anything(),
        }),
      }),
    )
  })

  it('reports only explicitly configured regression alert thresholds', async () => {
    mocks.caseFindMany.mockResolvedValue([])
    mocks.regressionPolicy.mockResolvedValue({
      version: 1,
      minimumPassRateDrop: 0.08,
      errorPassRateDrop: 0.2,
    })

    const result = await testRouter
      .createCaller(context())
      .evaluations.listEvaluationCases({ tenantId: 'tenant_1', venueId: 'venue_1' })

    expect(result.regressionAlerts).toEqual({
      configured: true,
      minimumPassRateDrop: 0.08,
      errorPassRateDrop: 0.2,
    })
  })

  it('rejects more than 50 requested cases before any scoped write work', async () => {
    const ids = Array.from(
      { length: 51 },
      (_, index) => `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
    )
    await expect(
      testRouter.createCaller(context()).evaluations.requestEvaluationRun({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        idempotencyKey: 'too-many',
        caseIds: ids,
        budgetCeilingE8Usd: '1',
      }),
    ).rejects.toBeTruthy()
    expect(mocks.createRun).not.toHaveBeenCalled()
  })

  it('rejects non-admin users before the tenant isolation bypass', async () => {
    await expect(
      testRouter.createCaller(context(false)).evaluations.listEvaluationRuns({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' } satisfies Partial<TRPCError>)
    expect(mocks.bypass).not.toHaveBeenCalled()
    expect(mocks.runFindMany).not.toHaveBeenCalled()
  })

  it('requests scoped, idempotent cancellation without exposing a queue primitive', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    await expect(
      testRouter.createCaller(context()).evaluations.cancelEvaluationRun({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        runId,
      }),
    ).resolves.toEqual({ cancellationRequested: true, replayed: false })
    expect(mocks.cancelRun).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      runId,
      requestedBy: 'operator_1',
      requestedByRole: 'PLATFORM_ADMIN',
    })
  })

  it('requires tenant and venue scope, safe selects, and stable pagination', async () => {
    const createdAt = new Date('2026-08-11T12:00:00.000Z')
    mocks.runFindMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', createdAt },
      { id: '22222222-2222-4222-8222-222222222222', createdAt },
    ])
    mocks.resultGroupBy.mockResolvedValue([])
    mocks.reviewFindMany.mockResolvedValue([])

    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      limit: 1,
    })

    expect(result.nextCursor).toEqual({
      createdAt: createdAt.toISOString(),
      id: '11111111-1111-4111-8111-111111111111',
    })
    expect(mocks.runFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: 'tenant_1', venueId: 'venue_1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 2,
        select: expect.not.objectContaining({
          identitySnapshot: expect.anything(),
          modelSnapshot: expect.anything(),
          runConfigSnapshot: expect.anything(),
          caseManifestSnapshot: expect.anything(),
        }),
      }),
    )
    expect(mocks.resultGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          runId: { in: ['11111111-1111-4111-8111-111111111111'] },
        },
      }),
    )
  })

  it('keeps quality failures distinct from operational outcomes and returns conclusions', async () => {
    const run = {
      id: '11111111-1111-4111-8111-111111111111',
      createdAt: new Date('2026-08-11T12:00:00.000Z'),
    }
    mocks.runFindMany.mockResolvedValue([run])
    mocks.resultGroupBy.mockResolvedValue([
      { runId: run.id, outcome: 'SCORED', passed: true, _count: { _all: 7 } },
      { runId: run.id, outcome: 'SCORED', passed: false, _count: { _all: 2 } },
      { runId: run.id, outcome: 'OPERATIONAL_FAILURE', passed: null, _count: { _all: 3 } },
      { runId: run.id, outcome: 'BUDGET_BLOCKED', passed: null, _count: { _all: 1 } },
    ])
    mocks.reviewFindMany.mockResolvedValue([{ id: 'review_1', conclusion: 'Needs source fix.' }])

    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })

    expect(result.items[0]?.summary).toEqual({
      resultCount: 13,
      quality: { scored: 9, passed: 7, failed: 2 },
      operational: { failures: 3, deferred: 0, budgetBlocked: 1, cancelled: 0 },
    })
    expect(result.humanConclusions).toEqual([{ id: 'review_1', conclusion: 'Needs source fix.' }])
  })

  it('does not issue secondary queries for an empty run page', async () => {
    const result = await testRouter.createCaller(context()).evaluations.listEvaluationRuns({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
    })

    expect(result).toEqual({ items: [], humanConclusions: [], failedCases: [], nextCursor: null })
    expect(mocks.resultGroupBy).not.toHaveBeenCalled()
    expect(mocks.resultFindMany).not.toHaveBeenCalled()
    expect(mocks.reviewFindMany).not.toHaveBeenCalled()
  })

  it('returns exact-scoped fail-closed comparison evidence without provider or write work', async () => {
    const baselineRunId = '11111111-1111-4111-8111-111111111111'
    const candidateRunId = '22222222-2222-4222-8222-222222222222'
    await expect(
      testRouter.createCaller(context()).evaluations.compareEvaluationRuns({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        baselineRunId,
        candidateRunId,
      }),
    ).resolves.toMatchObject({ status: 'INCOMPARABLE', mismatchReasons: ['CONTENT'] })
    expect(mocks.compareRuns).toHaveBeenCalledWith(
      { tenantId: 'tenant_1', venueId: 'venue_1', baselineRunId, candidateRunId },
      expect.anything(),
    )
    expect(mocks.createRun).not.toHaveBeenCalled()
  })

  it('appends a conclusion with server-owned HUMAN PLATFORM_ADMIN identity', async () => {
    const runId = '11111111-1111-4111-8111-111111111111'
    const resultId = '22222222-2222-4222-8222-222222222222'
    const operationId = '33333333-3333-4333-8333-333333333333'
    mocks.appendReview.mockResolvedValue({
      id: operationId,
      resultId,
      reviewerId: 'operator_1',
      conclusion: 'Accept this exact result.',
      decision: 'ACCEPTED',
      rubricVersion: 'operator-v1',
      revision: 1,
      createdAt: new Date('2026-08-12T12:00:00Z'),
      replayed: false,
      result: {
        runId,
        caseRevision: 2,
        evalCase: { caseKey: 'hours', category: 'grounding' },
      },
    })
    await expect(
      testRouter.createCaller(context()).evaluations.appendEvaluationConclusion({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        runId,
        expectedRunIdentityHash: 'a'.repeat(64),
        resultId,
        expectedRevision: 0,
        operationId,
        decision: 'ACCEPTED',
        conclusion: 'Accept this exact result.',
        rubricVersion: 'operator-v1',
      }),
    ).resolves.toMatchObject({ id: operationId, replayed: false })
    expect(mocks.appendReview).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        runId,
        resultId,
        actor: { type: 'HUMAN', id: 'operator_1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })
})
