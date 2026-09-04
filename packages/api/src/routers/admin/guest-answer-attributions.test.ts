import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  readAgreement: vi.fn(),
  findMany: vi.fn(),
  findEvaluationRequests: vi.fn(),
  tenantFlag: vi.fn(),
  durableEnabled: vi.fn(),
  durableAuthorization: vi.fn(),
  resolveConfiguration: vi.fn(),
  prepareEvaluation: vi.fn(),
  queueEvaluation: vi.fn(),
  enqueueEvaluation: vi.fn(),
  env: { EVALUATION_RUNNER_ENABLED: true },
  bypass: vi.fn(async (callback: () => unknown) => callback()),
}))

vi.mock('@pathfinder/config', () => ({ env: mocks.env }))
vi.mock('@pathfinder/ai', () => ({
  AI_CENTRAL_MODEL_REGISTRY: {
    'guest-answer-attribution-evaluation': { provider: 'anthropic' },
    'answer-analysis': { provider: 'openai' },
  },
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueGuestAnswerAttributionEvaluation: mocks.enqueueEvaluation,
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    guestAnswerAttribution: { findMany: mocks.findMany },
    guestAnswerAttributionEvaluationRequest: { findMany: mocks.findEvaluationRequests },
    tenantFeatureFlag: { findUnique: mocks.tenantFlag },
  },
  GuestAnswerAttributionActionError: class GuestAnswerAttributionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  GuestAnswerAttributionEvaluationError: class GuestAnswerAttributionEvaluationError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  isEvaluationRuntimeDurablyEnabled: mocks.durableEnabled,
  getEvaluationRuntimeAuthorization: mocks.durableAuthorization,
  prepareGuestAnswerAttributionEvaluationRequestAction: mocks.prepareEvaluation,
  queueGuestAnswerAttributionEvaluationRequestAction: mocks.queueEvaluation,
  recordHumanReviewedGuestAnswerAttributionAction: mocks.record,
  readGuestAnswerAttributionAgreement: mocks.readAgreement,
  resolveRuntimeAiWorkloadConfiguration: mocks.resolveConfiguration,
  withTenantIsolationBypass: mocks.bypass,
}))

import { adminGuestAnswerAttributionsRouter } from './guest-answer-attributions'

const caller = adminGuestAnswerAttributionsRouter.createCaller({
  session: {
    userId: 'admin-1',
    role: 'PLATFORM_ADMIN',
    activeTenantId: null,
    isPlatformAdmin: true,
  },
} as never)

describe('admin guest answer attributions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.env.EVALUATION_RUNNER_ENABLED = true
    mocks.record.mockResolvedValue({ attribution: { id: 'attribution-1' }, replayed: false })
    mocks.findMany.mockResolvedValue([])
    mocks.findEvaluationRequests.mockResolvedValue([])
    mocks.tenantFlag.mockResolvedValue({ enabled: true })
    mocks.durableEnabled.mockResolvedValue(true)
    mocks.durableAuthorization.mockResolvedValue({
      maxBudgetE8Usd: 105000000n,
      allowedProviders: ['anthropic'],
    })
    mocks.resolveConfiguration.mockResolvedValue({
      primaryModelKey: 'guest-answer-attribution-evaluation',
      fallback: { enabled: false, modelKeys: [] },
      requestBudgetCeilingE8Usd: '105000000',
    })
    mocks.prepareEvaluation.mockResolvedValue({ request: { id: 'request-1' }, replayed: false })
    mocks.queueEvaluation.mockResolvedValue({
      request: { id: 'request-1', answerHash: 'a'.repeat(64), evidenceSetHash: 'b'.repeat(64) },
      replayed: false,
    })
    mocks.enqueueEvaluation.mockResolvedValue({ enqueued: true })
    mocks.readAgreement.mockResolvedValue({
      target: 'HUMAN_CLAIM_REVIEW_CALIBRATION',
      reportHash: 'f'.repeat(64),
      invalidRecordCount: 0,
      truncated: false,
      report: {
        independentPairCount: 1,
        metrics: { supportAgreementRate: 1 },
      },
      interpretation: {
        establishesCorrectness: false,
        appliesQualityThreshold: false,
        authorizesRelease: false,
      },
    })
  })

  it('binds human review identity and exact scope to the canonical action', async () => {
    await caller.recordHumanReviewedGuestAnswerAttribution({
      operationId: '11111111-1111-4111-8111-111111111111',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
      evaluator: {
        provider: 'human-review',
        model: 'platform-admin',
        configurationVersion: 'review-form-v1',
        promptVersion: 'claim-rubric-v1',
      },
      claims: [],
    })

    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        guestChatTurnId: '22222222-2222-4222-8222-222222222222',
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      }),
      expect.anything(),
    )
  })

  it('returns a bounded tenant-and-venue scoped evidence list', async () => {
    await caller.listGuestAnswerAttributions({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
      limit: 10,
    })

    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          guestChatTurnId: '22222222-2222-4222-8222-222222222222',
        },
        take: 10,
      }),
    )
  })

  it('stages exact answer evidence under the authenticated human operator', async () => {
    await caller.prepareGuestAnswerAttributionEvaluation({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      operationId: '11111111-1111-4111-8111-111111111111',
      guestChatTurnId: '22222222-2222-4222-8222-222222222222',
    })
    expect(mocks.prepareEvaluation).toHaveBeenCalledWith(
      expect.objectContaining({
        guestChatTurnId: '22222222-2222-4222-8222-222222222222',
        actor: { type: 'HUMAN', id: 'admin-1', role: 'PLATFORM_ADMIN' },
      }),
    )
  })

  it('publishes only after all three execution gates and a durable QUEUED transition', async () => {
    const result = await caller.queueGuestAnswerAttributionEvaluation({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      requestId: '33333333-3333-4333-8333-333333333333',
    })
    expect(result.enqueued).toBe(true)
    expect(mocks.queueEvaluation).toHaveBeenCalledBefore(mocks.enqueueEvaluation)
    expect(mocks.enqueueEvaluation).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: '33333333-3333-4333-8333-333333333333',
        answerHash: 'a'.repeat(64),
        evidenceSetHash: 'b'.repeat(64),
      },
      { enabled: true },
    )
  })

  it('fails closed before queue mutation when the process gate is off', async () => {
    mocks.env.EVALUATION_RUNNER_ENABLED = false
    await expect(
      caller.queueGuestAnswerAttributionEvaluation({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.queueEvaluation).not.toHaveBeenCalled()
    expect(mocks.enqueueEvaluation).not.toHaveBeenCalled()
  })

  it('fails closed before queue mutation when routing exceeds the authorization', async () => {
    mocks.resolveConfiguration.mockResolvedValue({
      primaryModelKey: 'guest-answer-attribution-evaluation',
      fallback: { enabled: true, modelKeys: ['answer-analysis'] },
      requestBudgetCeilingE8Usd: '105000000',
    })
    await expect(
      caller.queueGuestAnswerAttributionEvaluation({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        requestId: '33333333-3333-4333-8333-333333333333',
      }),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.queueEvaluation).not.toHaveBeenCalled()
    expect(mocks.enqueueEvaluation).not.toHaveBeenCalled()
  })

  it('returns hashed descriptive agreement for independent human reviewers without a quality verdict', async () => {
    const result = await caller.previewGuestAnswerAttributionAgreement({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
    })

    expect(result.report.independentPairCount).toBe(1)
    expect(result.report.metrics.supportAgreementRate).toBe(1)
    expect(result.reportHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.interpretation).toEqual({
      establishesCorrectness: false,
      appliesQualityThreshold: false,
      authorizesRelease: false,
    })
    expect(result).not.toHaveProperty('passed')
    expect(mocks.readAgreement).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', venueId: 'venue-1', limit: 100 },
      expect.anything(),
    )
  })

  it('fails closed on malformed snapshots while preserving bounded calibration evidence', async () => {
    mocks.readAgreement.mockResolvedValue({
      target: 'HUMAN_CLAIM_REVIEW_CALIBRATION',
      reportHash: 'f'.repeat(64),
      invalidRecordCount: 1,
      truncated: false,
      report: { inputRecordCount: 0, independentPairCount: 0 },
      interpretation: {
        establishesCorrectness: false,
        appliesQualityThreshold: false,
        authorizesRelease: false,
      },
    })

    const result = await caller.previewGuestAnswerAttributionAgreement({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      limit: 2,
    })

    expect(result.invalidRecordCount).toBe(1)
    expect(result.report.inputRecordCount).toBe(0)
    expect(result.report.independentPairCount).toBe(0)
  })
})
