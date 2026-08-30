import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { AnswerAnalysisJobPayload } from '@pathfinder/jobs'

const mocks = vi.hoisted(() => ({
  acquireAnswerAnalysisExecution: vi.fn(),
  acquireAnswerAnalysisRecoveryExecution: vi.fn(),
  assertGlobalAiAvailable: vi.fn(),
  deferAnswerAnalysisExecution: vi.fn(),
  renewAnswerAnalysisExecution: vi.fn(),
  snapshotUpdateMany: vi.fn(),
  venueFindFirst: vi.fn(),
  responseFindMany: vi.fn(),
  messageFindMany: vi.fn(),
  aiUsageEventCreate: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  GENERATION_EXECUTION_LEASE_MS: 300_000,
  assertGlobalAiAvailable: mocks.assertGlobalAiAvailable,
  assertVenueAiAvailable: mocks.assertGlobalAiAvailable,
  reserveAiCostAttempt: vi.fn(async () => null),
  markAiCostAttemptDispatched: vi.fn(),
  settleAiCostAttemptExact: vi.fn(),
  settleAiCostAttemptAmbiguous: vi.fn(),
  releaseUndispatchedAiCostAttempt: vi.fn(),
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    name = 'GlobalAiAdmissionError'
    code: string
    constructor(code: string) {
      super('AI generation is temporarily unavailable.')
      this.code = code
    }
  },
  isAiAdmissionControlError: (error: unknown) =>
    error instanceof Error &&
    (error.name === 'GlobalAiAdmissionError' ||
      error.name === 'AiCostBudgetExceededError' ||
      error.name === 'AiCostBudgetUnavailableError' ||
      error.name === 'VenueUnavailableError'),
  acquireAnswerAnalysisExecution: mocks.acquireAnswerAnalysisExecution,
  acquireAnswerAnalysisRecoveryExecution: mocks.acquireAnswerAnalysisRecoveryExecution,
  deferAnswerAnalysisExecution: mocks.deferAnswerAnalysisExecution,
  renewAnswerAnalysisExecution: mocks.renewAnswerAnalysisExecution,
  db: {
    answerAnalysisSnapshot: {
      updateMany: mocks.snapshotUpdateMany,
    },
    venue: { findFirst: mocks.venueFindFirst },
    engagementQuestionResponse: { findMany: mocks.responseFindMany },
    message: { findMany: mocks.messageFindMany },
    aiUsageEvent: { create: mocks.aiUsageEventCreate },
  },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setAnthropicClientForTesting, processAnswerAnalysisJob } from './answer-analysis'

const anthropicCreate = vi.fn()
const mockAnthropic = { messages: { create: anthropicCreate } } as AnthropicMessagesClient
const LEASE_TOKEN = '11111111-1111-4111-8111-111111111111'

const payload: AnswerAnalysisJobPayload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  snapshotId: 'snapshot_1',
  rangeStart: '2026-06-01T00:00:00.000Z',
  rangeEnd: '2026-06-08T00:00:00.000Z',
}

const validSummary = {
  liked: ['Friendly staff'],
  improve: [],
  themes: ['Wayfinding'],
  complaints: [],
  mostMentioned: ['restrooms'],
  sentimentSummary: 'Mostly positive.',
  quotes: [],
  perQuestion: [{ questionText: 'What did you enjoy?', answerCount: 1, summary: 'Friendly staff' }],
  sampleSizeCaveat: null,
}

describe('processAnswerAnalysisJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropic)

    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.assertGlobalAiAvailable.mockResolvedValue(undefined)
    mocks.deferAnswerAnalysisExecution.mockResolvedValue(true)
    mocks.renewAnswerAnalysisExecution.mockResolvedValue(true)
    mocks.acquireAnswerAnalysisExecution.mockResolvedValue({
      state: 'acquired',
      leaseToken: LEASE_TOKEN,
    })
    mocks.acquireAnswerAnalysisRecoveryExecution.mockResolvedValue({
      state: 'acquired',
      leaseToken: LEASE_TOKEN,
    })
    mocks.snapshotUpdateMany.mockResolvedValue({ count: 1 })
    mocks.venueFindFirst.mockResolvedValue({ name: 'City Zoo' })
    mocks.responseFindMany.mockResolvedValue([
      {
        questionText: 'What did you enjoy?',
        answerText: 'Friendly staff',
        answerType: 'TEXT',
        isAiInvented: false,
      },
    ])
    mocks.messageFindMany.mockResolvedValue([
      { content: 'The signs were helpful.' },
      { content: 'Where are the restrooms?' },
    ])
    mocks.aiUsageEventCreate.mockResolvedValue({})
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validSummary) }],
      usage: { input_tokens: 100, output_tokens: 40 },
    })
  })

  it('loads the venue within the tenant boundary and records successful usage', async () => {
    await processAnswerAnalysisJob(payload, 'bull_job_1')

    expect(mocks.acquireAnswerAnalysisExecution).toHaveBeenCalledWith({
      snapshotId: 'snapshot_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: new Date('2026-06-01T00:00:00.000Z'),
      rangeEnd: new Date('2026-06-08T00:00:00.000Z'),
    })
    expect(mocks.venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { name: true },
    })
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6', max_tokens: 1_500 }),
      expect.objectContaining({ timeout: 30_000, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'answer-analysis',
        surface: 'worker',
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        success: true,
      }),
    })
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'COMPLETE',
        summary: validSummary,
        answerCount: 1,
        error: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fenced-releases its execution lease without recording failure when its venue pauses', async () => {
    const pause = Object.assign(new Error('venue unavailable'), { name: 'VenueUnavailableError' })
    mocks.assertGlobalAiAvailable.mockRejectedValueOnce(pause)

    await expect(processAnswerAnalysisJob(payload)).rejects.toBe(pause)

    expect(mocks.deferAnswerAnalysisExecution).toHaveBeenCalledWith({
      snapshotId: 'snapshot_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: new Date('2026-06-01T00:00:00.000Z'),
      rangeEnd: new Date('2026-06-08T00:00:00.000Z'),
      leaseToken: LEASE_TOKEN,
    })
    expect(mocks.snapshotUpdateMany).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('does not dispatch or settle snapshot state after lease ownership is lost', async () => {
    mocks.renewAnswerAnalysisExecution.mockResolvedValueOnce(false)

    await expect(processAnswerAnalysisJob(payload)).rejects.toMatchObject({
      code: 'execution-lease-ownership-lost',
    })

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.snapshotUpdateMany).not.toHaveBeenCalled()
    expect(mocks.deferAnswerAnalysisExecution).not.toHaveBeenCalled()
  })

  it('uses an exact observed-token recovery claim without persisting the token', async () => {
    const observedLeaseToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    await processAnswerAnalysisJob(payload, 'bull_recovery_1', { observedLeaseToken })

    expect(mocks.acquireAnswerAnalysisExecution).not.toHaveBeenCalled()
    expect(mocks.acquireAnswerAnalysisRecoveryExecution).toHaveBeenCalledWith({
      snapshotId: 'snapshot_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: new Date('2026-06-01T00:00:00.000Z'),
      rangeEnd: new Date('2026-06-08T00:00:00.000Z'),
      observedLeaseToken,
    })
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'answer-analysis-recovery',
        payload,
      }),
    )
    expect(JSON.stringify(mocks.writeJobRecord.mock.calls)).not.toContain(observedLeaseToken)
  })

  it('completes an ineligible recovery delivery without reads or provider work', async () => {
    mocks.acquireAnswerAnalysisRecoveryExecution.mockResolvedValueOnce({ state: 'ineligible' })

    await expect(
      processAnswerAnalysisJob(payload, 'bull_recovery_superseded', {
        observedLeaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).resolves.toBeUndefined()

    expect(mocks.venueFindFirst).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it.each(['missing', 'terminal'] as const)(
    'completes a %s snapshot delivery without lifecycle writes, reads, or provider work',
    async (state) => {
      mocks.acquireAnswerAnalysisExecution.mockResolvedValueOnce({ state })

      await expect(processAnswerAnalysisJob(payload, 'bull_noop')).resolves.toBeUndefined()

      expect(mocks.acquireAnswerAnalysisExecution).toHaveBeenCalledWith({
        snapshotId: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        rangeStart: new Date('2026-06-01T00:00:00.000Z'),
        rangeEnd: new Date('2026-06-08T00:00:00.000Z'),
      })
      expect(mocks.snapshotUpdateMany).not.toHaveBeenCalled()
      expect(mocks.venueFindFirst).not.toHaveBeenCalled()
      expect(mocks.responseFindMany).not.toHaveBeenCalled()
      expect(mocks.messageFindMany).not.toHaveBeenCalled()
      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
        status: 'COMPLETE',
      })
    },
  )

  it('completes a persisted-range mismatch without source or provider work', async () => {
    mocks.acquireAnswerAnalysisExecution.mockResolvedValueOnce({ state: 'missing' })

    await expect(processAnswerAnalysisJob(payload, 'bull_wrong_range')).resolves.toBeUndefined()

    expect(mocks.acquireAnswerAnalysisExecution).toHaveBeenCalledWith({
      snapshotId: 'snapshot_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      rangeStart: new Date('2026-06-01T00:00:00.000Z'),
      rangeEnd: new Date('2026-06-08T00:00:00.000Z'),
    })
    expect(mocks.snapshotUpdateMany).not.toHaveBeenCalled()
    expect(mocks.venueFindFirst).not.toHaveBeenCalled()
    expect(mocks.responseFindMany).not.toHaveBeenCalled()
    expect(mocks.messageFindMany).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('fails a leased delivery retryably without reads, provider work, or domain mutation', async () => {
    mocks.acquireAnswerAnalysisExecution.mockResolvedValueOnce({ state: 'leased' })

    await expect(
      processAnswerAnalysisJob(payload, {
        bullJobId: 'bull_leased',
        attemptNumber: 1,
        maxAttempts: 6,
      }),
    ).rejects.toThrow('Answer analysis execution is already leased.')

    expect(mocks.snapshotUpdateMany).not.toHaveBeenCalled()
    expect(mocks.venueFindFirst).not.toHaveBeenCalled()
    expect(mocks.responseFindMany).not.toHaveBeenCalled()
    expect(mocks.messageFindMany).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
  })

  it('fails before the provider call when the venue is not owned by the tenant', async () => {
    mocks.venueFindFirst.mockResolvedValueOnce(null)

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow(
      'Venue venue_1 not found for tenant tenant_1',
    )

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
  })

  it('completes without an AI call when the combined signal is insufficient', async () => {
    mocks.responseFindMany.mockResolvedValueOnce([])
    mocks.messageFindMany.mockResolvedValueOnce([{ content: 'Hello' }, { content: 'Thanks' }])

    await expect(processAnswerAnalysisJob(payload)).resolves.toBeUndefined()

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'COMPLETE',
        answerCount: 0,
        summary: expect.objectContaining({ sampleSizeCaveat: expect.any(String) }),
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
  })

  it('records observed usage and fails the job for malformed structured output', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"liked":"not-an-array"}' }],
      usage: { input_tokens: 80, output_tokens: 12 },
    })

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow()

    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'answer-analysis',
        success: false,
        errorCode: 'invalid-structured-output',
        inputTokens: 80,
        outputTokens: 12,
        totalTokens: 92,
      }),
    })
    const failureUsage = mocks.aiUsageEventCreate.mock.calls[0]?.[0]?.data as {
      estimatedCostUsd: number
    }
    expect(failureUsage.estimatedCostUsd).toBeGreaterThan(0)
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
  })

  it('leaves retryable provider failures to BullMQ without an inner retry', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    anthropicCreate.mockRejectedValue(providerError)

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow('provider unavailable')

    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feature: 'answer-analysis',
        success: false,
        errorCode: 'provider-http-503',
        attempts: 1,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
  })

  it('preserves the primary failure when auxiliary failure status persistence rejects', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    anthropicCreate.mockRejectedValueOnce(providerError)
    mocks.snapshotUpdateMany.mockImplementation(async (params) => {
      if (params.data.status === 'FAILED') throw new Error('snapshot database unavailable')
      return { count: 1 }
    })

    await expect(processAnswerAnalysisJob(payload)).rejects.toMatchObject({
      name: 'AiGatewayError',
      message: 'provider unavailable',
      code: 'provider-http-503',
    })

    const jobRecordOrder = mocks.updateJobRecord.mock.invocationCallOrder[0]
    const failedSnapshotCallIndex = mocks.snapshotUpdateMany.mock.calls.findIndex(
      ([params]) => params.data.status === 'FAILED',
    )
    const failedSnapshotOrder =
      mocks.snapshotUpdateMany.mock.invocationCallOrder[failedSnapshotCallIndex]

    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED', error: 'JOB_ATTEMPTS_EXHAUSTED' }),
    )
    expect(failedSnapshotCallIndex).toBeGreaterThanOrEqual(0)
    expect(jobRecordOrder).toBeLessThan(failedSnapshotOrder as number)
  })

  it('preserves the primary failure when the exact failure ownership state no longer matches', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    anthropicCreate.mockRejectedValueOnce(providerError)
    mocks.snapshotUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processAnswerAnalysisJob(payload)).rejects.toMatchObject({
      name: 'AiGatewayError',
      message: 'provider unavailable',
      code: 'provider-http-503',
    })

    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: {
        status: 'FAILED',
        error: 'provider unavailable',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
  })

  it('does not fail a successful analysis when usage persistence is unavailable', async () => {
    mocks.aiUsageEventCreate.mockRejectedValueOnce(new Error('usage database unavailable'))

    await expect(processAnswerAnalysisJob(payload)).resolves.toBeUndefined()

    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'snapshot_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: LEASE_TOKEN,
      },
      data: expect.objectContaining({
        status: 'COMPLETE',
        summary: validSummary,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('rejects a stale-token success without overwriting the current owner state', async () => {
    mocks.snapshotUpdateMany.mockResolvedValue({ count: 0 })

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow(
      'The answer-analysis snapshot ownership state no longer matched.',
    )

    expect(anthropicCreate).toHaveBeenCalledOnce()
    expect(mocks.snapshotUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.snapshotUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ executionLeaseToken: LEASE_TOKEN }),
        data: expect.objectContaining({ status: 'COMPLETE' }),
      }),
    )
    expect(mocks.snapshotUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ executionLeaseToken: LEASE_TOKEN }),
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    )
  })

  it('does not rewrite a completed snapshot when JobRecord completion persistence fails', async () => {
    mocks.updateJobRecord.mockRejectedValueOnce(new Error('job record unavailable'))

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow('job record unavailable')

    expect(mocks.snapshotUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.snapshotUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ executionLeaseToken: LEASE_TOKEN }),
        data: expect.objectContaining({ status: 'COMPLETE' }),
      }),
    )
  })
})
