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
  loadReviewablePreview: vi.fn(),
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
  platformConfigFind: vi.fn(),
  platformConfigUpsert: vi.fn(),
  tenantFlagUpsert: vi.fn(),
  auditCreate: vi.fn(),
  contentVersionContext: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({ env: { EVALUATION_RUNNER_ENABLED: true } }))

vi.mock('@pathfinder/ai', () => ({
  AI_MODEL_KEYS: { GUEST_CHAT: 'guest-chat', GUEST_CHAT_OPENAI: 'guest-chat-openai' },
  getAiModelSpec: (modelKey: string) =>
    modelKey === 'guest-chat-openai'
      ? { provider: 'openai', model: 'openai-candidate', maxOutputTokens: 512 }
      : { provider: 'anthropic', model: 'frozen-model', maxOutputTokens: 512 },
}))

vi.mock('@pathfinder/jobs', () => ({ enqueueEvaluationRun: mocks.enqueueRun }))

vi.mock('../portal', () => ({ loadClientPreview: mocks.loadPreview }))

vi.mock('../../lib/reviewable-package-evaluation', () => ({
  loadReviewableVenuePackageEvaluationPreview: mocks.loadReviewablePreview,
}))

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
  EVALUATION_RUNTIME_GLOBAL_CONFIG_KEY: 'evaluation-runner-v1-global',
  setContentVersionContext: mocks.contentVersionContext,
  getEvaluationRegressionAlertPolicy: mocks.regressionPolicy,
  markEvaluationRunQueued: mocks.markQueued,
  db: {
    $transaction: vi.fn(async (operation) =>
      operation({
        evalCase: { findMany: mocks.caseFindMany },
        venuePackage: { findFirst: mocks.venuePackageFind },
        tenantFeatureFlag: {
          findUnique: mocks.featureEnabled,
          upsert: mocks.tenantFlagUpsert,
        },
        nativeVenueDeploymentRelease: { findFirst: mocks.nativeReleaseFind },
        venue: { findFirst: mocks.venueFind },
        platformConfig: {
          findUnique: mocks.platformConfigFind,
          upsert: mocks.platformConfigUpsert,
        },
        auditLog: { create: mocks.auditCreate },
      }),
    ),
    evalRun: { findMany: mocks.runFindMany },
    evalResult: { groupBy: mocks.resultGroupBy, findMany: mocks.resultFindMany },
    evalReview: { findMany: mocks.reviewFindMany },
    evalCase: { findMany: mocks.caseFindMany },
    venue: { findFirst: mocks.venueFind },
    onboardingMilestoneEvent: { findMany: mocks.milestoneFindMany },
    tenantFeatureFlag: { findUnique: mocks.featureEnabled, upsert: mocks.tenantFlagUpsert },
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
    mocks.platformConfigFind.mockResolvedValue(null)
    mocks.venueFind.mockResolvedValue({ id: 'venue_1' })
    mocks.platformConfigUpsert.mockResolvedValue({})
    mocks.tenantFlagUpsert.mockResolvedValue({})
    mocks.auditCreate.mockResolvedValue({})
    mocks.contentVersionContext.mockResolvedValue(undefined)
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

  it('atomically enables exact durable evaluation gates after explicit confirmation', async () => {
    const result = await testRouter
      .createCaller(context())
      .evaluations.setEvaluationRuntimeDurableGates({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: true,
        expectedGlobalEnabled: false,
        expectedTenantEnabled: false,
        confirmation: 'ENABLE EVALUATION RUNNER',
      })

    expect(result).toEqual({
      apiProcessEnabled: true,
      durableGlobalEnabled: true,
      tenantEnabled: true,
      executionEnabled: true,
    })
    expect(mocks.platformConfigUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'evaluation-runner-v1-global' },
        update: expect.objectContaining({ value: { version: 1, enabled: true } }),
      }),
    )
    expect(mocks.tenantFlagUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId_flagKey: { tenantId: 'tenant_1', flagKey: 'evaluation-runner-v1' },
        },
        update: expect.objectContaining({ enabled: true, setBy: 'operator_1' }),
      }),
    )
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        action: 'admin.evaluation-runtime.enabled',
        targetId: 'tenant_1:venue_1',
        beforeState: { durableGlobalEnabled: false, tenantEnabled: false },
        afterState: { durableGlobalEnabled: true, tenantEnabled: true },
      }),
    })
  })

  it('fails closed on stale durable readiness without writing either gate', async () => {
    mocks.platformConfigFind.mockResolvedValue({ value: { version: 1, enabled: true } })

    await expect(
      testRouter.createCaller(context()).evaluations.setEvaluationRuntimeDurableGates({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: true,
        expectedGlobalEnabled: false,
        expectedTenantEnabled: false,
        confirmation: 'ENABLE EVALUATION RUNNER',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(mocks.platformConfigUpsert).not.toHaveBeenCalled()
    expect(mocks.tenantFlagUpsert).not.toHaveBeenCalled()
    expect(mocks.auditCreate).not.toHaveBeenCalled()
  })

  it('requires the exact enable phrase but permits immediate audited disable', async () => {
    await expect(
      testRouter.createCaller(context()).evaluations.setEvaluationRuntimeDurableGates({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: true,
        expectedGlobalEnabled: false,
        expectedTenantEnabled: false,
        confirmation: 'enable',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })

    mocks.platformConfigFind.mockResolvedValue({ value: { version: 1, enabled: true } })
    mocks.featureEnabled.mockResolvedValue({ enabled: true })
    const disabled = await testRouter
      .createCaller(context())
      .evaluations.setEvaluationRuntimeDurableGates({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        enabled: false,
        expectedGlobalEnabled: true,
        expectedTenantEnabled: true,
      })
    expect(disabled.executionEnabled).toBe(false)
    expect(mocks.auditCreate).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: 'admin.evaluation-runtime.disabled' }),
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

  it('prepares the seven versioned onboarding dimensions from one exact reviewable package', async () => {
    mocks.venuePackageFind.mockResolvedValue({
      id: 'package_1',
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      status: 'DRAFT',
    })
    mocks.caseFindMany.mockResolvedValue([])
    mocks.loadReviewablePreview.mockResolvedValue({
      preview: {
        venue: { id: 'venue_1', name: 'Test Venue' },
        package: {
          id: 'package_1',
          status: 'DRAFT',
          payloadHash: 'a'.repeat(64),
          baseDigest: 'b'.repeat(64),
          evidenceAt: '2026-08-24T12:00:00.000Z',
        },
        experience: {
          places: [{ name: 'Lobby' }],
          knowledgeEntries: [
            { title: 'Parking', category: 'arrival', content: 'Parking is beside the lobby.' },
          ],
        },
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
    expect(mocks.loadReviewablePreview).toHaveBeenCalledWith(expect.anything(), 'tenant_1', {
      venueId: 'venue_1',
      packageId: 'package_1',
    })
    expect(mocks.createCase).toHaveBeenCalledTimes(7)
    expect(mocks.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
          sourceRef: `venue-package-review:package_1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
          createdBy: 'operator_1',
        }),
      }),
    )
  })

  it('prepares paired grounded and fallback cases for every launch language', async () => {
    mocks.venuePackageFind.mockResolvedValue({
      id: 'package_1',
      payloadHash: 'a'.repeat(64),
      baseDigest: 'b'.repeat(64),
      status: 'DRAFT',
    })
    mocks.caseFindMany.mockResolvedValue([])
    mocks.loadReviewablePreview.mockResolvedValue({
      preview: {
        venue: { id: 'venue_1', name: 'Test Venue' },
        package: {
          id: 'package_1',
          status: 'DRAFT',
          payloadHash: 'a'.repeat(64),
          baseDigest: 'b'.repeat(64),
          evidenceAt: '2026-08-24T12:00:00.000Z',
        },
        experience: { places: [{ name: 'Lobby' }], knowledgeEntries: [] },
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
        suite: 'LAUNCH_LANGUAGES',
      })

    expect(result.suiteVersion).toBe('torchiko-launch-language-evaluation-suite-v1')
    expect(result.cases).toHaveLength(20)
    expect(
      result.cases.filter((item) => item.dimension === 'launch-language-grounded'),
    ).toHaveLength(10)
    expect(
      result.cases.filter((item) => item.dimension === 'launch-language-fallback'),
    ).toHaveLength(10)
    expect(mocks.createCase).toHaveBeenCalledTimes(20)
    expect(mocks.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          caseKey: 'onboarding-language-ar-fallback',
          sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
          sourceRef: `venue-package-review:package_1:${'a'.repeat(64)}:${'b'.repeat(64)}`,
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

  it('freezes only an allow-listed OpenAI evaluation candidate selected by registry key', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    mocks.caseFindMany.mockResolvedValue([{ id: caseId, revision: 1, caseHash: 'b'.repeat(64) }])
    mocks.createSnapshot.mockResolvedValue({
      schemaVersion: 'pathfinder-venue-content-snapshot-v1',
      hash: 'c'.repeat(64),
      contentVersion: 1n,
      componentCounts: { venue: 1, places: 0, knowledgeEntries: 0 },
      manifest: { tenantId: 'tenant_1', venueId: 'venue_1', frozen: true },
    })
    mocks.createRun.mockImplementation(async ({ identity }) => ({
      run: { id: caseId, identityHash: 'd'.repeat(64), status: 'STAGED' },
      replayed: false,
      identity,
    }))
    mocks.featureEnabled.mockResolvedValue({ enabled: true })

    await testRouter.createCaller(context()).evaluations.requestEvaluationRun({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      idempotencyKey: 'openai-candidate-request',
      caseIds: [caseId],
      budgetCeilingE8Usd: '5102400',
      modelKey: 'guest-chat-openai',
    })

    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          modelProvider: 'openai',
          modelName: 'openai-candidate',
          modelSnapshot: expect.objectContaining({ provider: 'openai' }),
          runConfigSnapshot: expect.objectContaining({ modelKey: 'guest-chat-openai' }),
        }),
      }),
    )
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
            responseDepth: 'BALANCED',
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

  it('freezes a support-linked DRAFT package for evaluation without approving or applying it', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    const payloadHash = 'c'.repeat(64)
    const baseDigest = 'd'.repeat(64)
    mocks.caseFindMany.mockResolvedValue([
      {
        id: caseId,
        revision: 1,
        caseHash: 'b'.repeat(64),
        sourceType: 'ONBOARDING_REVIEWABLE_PACKAGE',
        sourceRef: `venue-package-review:package_1:${payloadHash}:${baseDigest}`,
      },
    ])
    mocks.featureEnabled.mockResolvedValue({ enabled: true })
    mocks.venuePackageFind.mockResolvedValue({
      id: 'package_1',
      payloadHash,
      baseDigest,
      status: 'DRAFT',
    })
    mocks.loadReviewablePreview.mockResolvedValue({
      package: { id: 'package_1', status: 'DRAFT', payloadHash, baseDigest },
      preview: {
        venue: { id: 'venue_1', name: 'Draft venue' },
        package: {
          id: 'package_1',
          status: 'DRAFT',
          payloadHash,
          baseDigest,
          evidenceAt: '2026-08-24T12:00:00.000Z',
        },
        experience: {
          places: [],
          knowledgeEntries: [],
          summary: { placeCount: 0, knowledgeEntryCount: 0 },
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
      idempotencyKey: 'reviewable-package-1',
      caseIds: [caseId],
      budgetCeilingE8Usd: '1000',
      reviewablePackageId: 'package_1',
    })

    expect(mocks.createSnapshot).not.toHaveBeenCalled()
    expect(mocks.loadPreview).not.toHaveBeenCalled()
    expect(mocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          contentSnapshotKind: 'REVIEWABLE_VENUE_PACKAGE_V1',
          contentSnapshotRef: 'package_1',
          contentSnapshotVersion: 1n,
          contentSnapshotHash: '9'.repeat(64),
          packageSnapshotRef: 'venue-package-review-v1:package_1',
          packageSnapshotHash: payloadHash,
          triggerType: 'ADMIN_REVIEWABLE_PACKAGE_REQUEST',
          runConfigSnapshot: expect.objectContaining({
            version: 'pathfinder-reviewable-package-evaluation-run-config-v1',
            contentSnapshot: expect.objectContaining({
              packageId: 'package_1',
              packageStatus: 'DRAFT',
              payloadHash,
              baseDigest,
            }),
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

  it('previews exact current-source lexical coverage without returning source content', async () => {
    const caseId = '11111111-1111-4111-8111-111111111111'
    mocks.caseFindMany.mockResolvedValue([
      {
        id: caseId,
        caseKey: 'known-case',
        revision: 2,
        caseHash: 'f'.repeat(64),
        caseSnapshot: {
          schemaVersion: 'pathfinder-eval-v1',
          caseId: 'known-case',
          category: 'known-answer',
          venue: {
            fixtureId: 'venue',
            guideMode: 'non_location',
            placeNameUniverse: [],
            allowedPlaceNames: [],
          },
          turns: [{ role: 'user', content: 'Where is it?' }],
          rules: {
            requiredPhrases: [{ ruleId: 'subject', phrase: 'Tide Clock' }],
            requiredFacts: [
              { ruleId: 'location', acceptablePhrases: ['east atrium', 'eastern atrium'] },
            ],
            forbiddenPhrases: [],
            maxWords: 30,
            unknownAnswer: { required: false, ruleId: 'unknown', acceptablePhrases: [] },
          },
        },
      },
    ])
    mocks.createSnapshot.mockResolvedValue({
      hash: 'a'.repeat(64),
      contentVersion: 7n,
      manifest: { places: [{ name: 'Tide Clock', description: 'In the eastern atrium.' }] },
    })

    const result = await testRouter
      .createCaller(context())
      .evaluations.previewCurrentEvaluationSourceCoverage({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        caseIds: [caseId],
      })

    expect(result).toMatchObject({
      target: 'CURRENT_LIVE_CONTENT',
      contentSnapshotHash: 'a'.repeat(64),
      contentVersion: '7',
      cases: [
        {
          caseId,
          caseKey: 'known-case',
          revision: 2,
          coverage: { supportedMarkers: 2, totalMarkers: 2 },
        },
      ],
    })
    expect(JSON.stringify(result)).not.toContain('In the eastern atrium')
    expect(mocks.createSnapshot).toHaveBeenCalledWith({
      db: expect.anything(),
      tenantId: 'tenant_1',
      venueId: 'venue_1',
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
