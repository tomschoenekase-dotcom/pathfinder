import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  env: { EVALUATION_RUNNER_ENABLED: true },
  durableEnabled: vi.fn(),
  runtimeAuthorization: vi.fn(),
  tenantFlag: vi.fn(),
  ownedRequest: vi.fn(),
  queuedRequests: vi.fn(),
  assertVenue: vi.fn(),
  claim: vi.fn(),
  markDispatched: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  recover: vi.fn(),
  resolveConfiguration: vi.fn(),
  evaluate: vi.fn(),
  enqueue: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: mocks.env,
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}))
vi.mock('@pathfinder/ai', () => ({
  AI_CENTRAL_MODEL_REGISTRY: {
    'guest-answer-attribution-evaluation': { provider: 'anthropic' },
    'answer-analysis': { provider: 'openai' },
  },
  AiGatewayError: class AiGatewayError extends Error {
    readonly code: string

    constructor(message: string, options: { code: string }) {
      super(message)
      this.code = options.code
    }
  },
  AiRequestBudgetCeilingExceededError: class extends Error {
    code = 'AI_BUDGET_BLOCKED'
  },
  AiRoutingError: class extends Error {
    code = 'AI_ROUTE_FAILED'
  },
}))
vi.mock('@pathfinder/db', () => ({
  assertVenueAiAvailable: mocks.assertVenue,
  claimGuestAnswerAttributionEvaluationRequestAction: mocks.claim,
  completeGuestAnswerAttributionEvaluationRequestAction: mocks.complete,
  db: {
    tenantFeatureFlag: { findUnique: mocks.tenantFlag },
    guestAnswerAttributionEvaluationRequest: {
      findFirst: mocks.ownedRequest,
      findMany: mocks.queuedRequests,
    },
  },
  failGuestAnswerAttributionEvaluationRequestAction: mocks.fail,
  isEvaluationRuntimeDurablyEnabled: mocks.durableEnabled,
  getEvaluationRuntimeAuthorization: mocks.runtimeAuthorization,
  markGuestAnswerAttributionEvaluationDispatchedAction: mocks.markDispatched,
  recoverStaleGuestAnswerAttributionEvaluationRequestsAction: mocks.recover,
  resolveRuntimeAiWorkloadConfiguration: mocks.resolveConfiguration,
  withTenantIsolationBypass: (operation: () => unknown) => operation(),
}))
vi.mock('@pathfinder/jobs', () => ({
  enqueueGuestAnswerAttributionEvaluation: mocks.enqueue,
}))
vi.mock('@pathfinder/api/guest-answer-attribution-evaluation', () => ({
  runProviderBackedGuestAnswerAttributionEvaluation: mocks.evaluate,
}))
vi.mock('../lib/ai-usage', () => ({
  createWorkerAiBudgetGate: vi.fn(() => ({})),
  createWorkerAiUsageSink: vi.fn(() => vi.fn()),
}))

import {
  processGuestAnswerAttributionEvaluationJob,
  recoverGuestAnswerAttributionEvaluations,
} from './guest-answer-attribution-evaluation'
import { AiGatewayError } from '@pathfinder/ai'

const payload = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  requestId: '11111111-1111-4111-8111-111111111111',
  answerHash: 'a'.repeat(64),
  evidenceSetHash: 'b'.repeat(64),
}

const authorization = {
  authorizationId: '22222222-2222-4222-8222-222222222222',
  authorizedAt: new Date('2026-09-04T16:00:00.000Z'),
  expiresAt: new Date('2099-09-04T18:00:00.000Z'),
  maxBudgetE8Usd: 105000000n,
  allowedProviders: ['anthropic'],
}

describe('guest answer attribution evaluator worker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.env.EVALUATION_RUNNER_ENABLED = true
    mocks.durableEnabled.mockResolvedValue(true)
    mocks.runtimeAuthorization.mockResolvedValue(authorization)
    mocks.tenantFlag.mockResolvedValue({ enabled: true })
    mocks.ownedRequest.mockResolvedValue({
      id: payload.requestId,
      queuedAt: new Date('2026-09-04T17:00:00.000Z'),
    })
    mocks.queuedRequests.mockResolvedValue([])
    mocks.assertVenue.mockResolvedValue(undefined)
    mocks.claim.mockResolvedValue({
      state: 'claimed',
      request: { id: payload.requestId, ...payload },
      answer: 'The gallery is open.',
      evidence: { answerHash: payload.answerHash, evidenceSetHash: payload.evidenceSetHash },
    })
    mocks.markDispatched.mockResolvedValue(undefined)
    mocks.complete.mockResolvedValue({ requestId: payload.requestId })
    mocks.fail.mockResolvedValue(undefined)
    mocks.recover.mockResolvedValue([])
    mocks.resolveConfiguration.mockResolvedValue({
      workloadId: 'guest-answer-attribution-evaluation',
      configurationVersion: 'ai-workload-config-v1',
      primaryModelKey: 'guest-answer-attribution-evaluation',
      fallback: { enabled: false, modelKeys: [] },
      requestBudgetCeilingE8Usd: '105000000',
    })
    mocks.evaluate.mockImplementation(async (input) => {
      await input.admissionGuard()
      await input.onBeforeFirstDispatch()
      return { attribution: { evaluator: {}, claims: [] } }
    })
    mocks.enqueue.mockResolvedValue({ enqueued: true })
  })

  it('rechecks every gate, acquires the durable dispatch fence, and completes exact evidence', async () => {
    await processGuestAnswerAttributionEvaluationJob(payload)

    expect(mocks.claim).toHaveBeenCalledOnce()
    expect(mocks.assertVenue).toHaveBeenCalledWith(expect.anything(), {
      tenantId: payload.tenantId,
      venueId: payload.venueId,
    })
    expect(mocks.markDispatched).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: payload.requestId, leaseToken: expect.any(String) }),
    )
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: payload.requestId, attribution: expect.any(Object) }),
    )
    expect(mocks.fail).not.toHaveBeenCalled()
  })

  it('does not claim or dispatch when any default-off admission layer is disabled', async () => {
    mocks.durableEnabled.mockResolvedValue(false)
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).resolves.toEqual({
      state: 'disabled',
    })
    expect(mocks.claim).not.toHaveBeenCalled()
    expect(mocks.evaluate).not.toHaveBeenCalled()
  })

  it('records a bounded terminal failure after a claimed provider operation fails', async () => {
    mocks.evaluate.mockRejectedValue(new Error('provider detail that must not become a code'))
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).rejects.toThrow()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: payload.requestId,
        errorCode: 'GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILED',
      }),
    )
  })

  it('blocks provider admission when a replacement authorization cannot own the queued request', async () => {
    mocks.runtimeAuthorization.mockResolvedValue({
      ...authorization,
      authorizedAt: new Date('2099-09-04T17:30:00.000Z'),
      expiresAt: new Date('2099-09-04T18:00:00.000Z'),
    })
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).rejects.toThrow(
      'not queued in the active authorization window',
    )
    expect(mocks.markDispatched).not.toHaveBeenCalled()
    expect(mocks.fail).toHaveBeenCalled()
  })

  it('blocks configured fallback providers outside the active authorization', async () => {
    mocks.resolveConfiguration.mockResolvedValue({
      workloadId: 'guest-answer-attribution-evaluation',
      configurationVersion: 'ai-workload-config-v1',
      primaryModelKey: 'guest-answer-attribution-evaluation',
      fallback: { enabled: true, modelKeys: ['answer-analysis'] },
      requestBudgetCeilingE8Usd: '105000000',
    })
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).rejects.toThrow(
      'outside the active authorization',
    )
    expect(mocks.markDispatched).not.toHaveBeenCalled()
  })

  it('maps provider codes into a finite durable failure vocabulary', async () => {
    mocks.evaluate.mockRejectedValue(
      new AiGatewayError('provider failure', {
        attempts: 1,
        code: 'provider-connection-timeout',
      }),
    )
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).rejects.toThrow()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: payload.requestId,
        errorCode: 'PROVIDER_CONNECTION_FAILED',
      }),
    )
  })

  it('does not persist an unknown secret-like provider code', async () => {
    mocks.evaluate.mockRejectedValue(
      new AiGatewayError('provider failure', { attempts: 1, code: 'UPSTREAM_SECRET_TOKEN' }),
    )
    await expect(processGuestAnswerAttributionEvaluationJob(payload)).rejects.toThrow()
    expect(mocks.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: payload.requestId,
        errorCode: 'PROVIDER_REQUEST_FAILED',
      }),
    )
    expect(JSON.stringify(mocks.fail.mock.calls)).not.toContain('UPSTREAM_SECRET_TOKEN')
  })

  it('republishes durable queued work but never republishes ambiguous recovery rows', async () => {
    mocks.recover.mockResolvedValue([
      { requestId: 'lost', state: 'AMBIGUOUS', tenantId: 'tenant-1', venueId: 'venue-1' },
    ])
    mocks.queuedRequests.mockResolvedValue([
      { id: payload.requestId, ...payload, attemptNumber: 1 },
    ])
    await expect(recoverGuestAnswerAttributionEvaluations()).resolves.toEqual({
      recovered: 1,
      published: 1,
    })
    expect(mocks.enqueue).toHaveBeenCalledOnce()
    expect(mocks.enqueue).toHaveBeenCalledWith(payload, {
      enabled: true,
      dispatchKey: 'recovery-1',
    })
    expect(mocks.queuedRequests).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          queuedAt: {
            gte: authorization.authorizedAt,
            lte: authorization.expiresAt,
          },
        }),
      }),
    )
  })
})
