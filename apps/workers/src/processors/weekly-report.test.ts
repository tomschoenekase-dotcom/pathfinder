import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { WeeklyReportJobPayload } from '@pathfinder/jobs'

const mocks = vi.hoisted(() => ({
  acquireWeeklyReportExecution: vi.fn(),
  acquireWeeklyReportRecoveryExecution: vi.fn(),
  assertGlobalAiAvailable: vi.fn(),
  deferWeeklyReportExecution: vi.fn(),
  renewWeeklyReportExecution: vi.fn(),
  reportUpdateMany: vi.fn(),
  venueFindFirst: vi.fn(),
  sessionCount: vi.fn(),
  messageCount: vi.fn(),
  responseFindMany: vi.fn(),
  questionFindMany: vi.fn(),
  noteFindMany: vi.fn(),
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
  db: {
    weeklyReport: { updateMany: mocks.reportUpdateMany },
    venue: { findFirst: mocks.venueFindFirst },
    visitorSession: { count: mocks.sessionCount },
    message: { count: mocks.messageCount, findMany: mocks.messageFindMany },
    engagementQuestionResponse: { findMany: mocks.responseFindMany },
    engagementQuestion: { findMany: mocks.questionFindMany },
    adminChatlogNote: { findMany: mocks.noteFindMany },
    aiUsageEvent: { create: mocks.aiUsageEventCreate },
  },
  acquireWeeklyReportExecution: mocks.acquireWeeklyReportExecution,
  acquireWeeklyReportRecoveryExecution: mocks.acquireWeeklyReportRecoveryExecution,
  deferWeeklyReportExecution: mocks.deferWeeklyReportExecution,
  renewWeeklyReportExecution: mocks.renewWeeklyReportExecution,
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setAnthropicClientForTesting, processWeeklyReportJob } from './weekly-report'
import { GlobalAiAdmissionError } from '@pathfinder/db'

const anthropicCreate = vi.fn()
const mockAnthropic = { messages: { create: anthropicCreate } } as AnthropicMessagesClient

const payload: WeeklyReportJobPayload = {
  tenantId: 'tenant_1',
  venueId: 'venue_1',
  reportId: 'report_1',
  weekStart: '2026-06-01T00:00:00.000Z',
  weekEnd: '2026-06-08T00:00:00.000Z',
}

const validReport = {
  overview: 'Visitors had a positive week.',
  visitorQuestionsAndInterests: 'Restroom locations came up repeatedly.',
  specificAnalytics: 'One visitor answered the active satisfaction question.',
  notableInsight: 'Wayfinding remains the clearest opportunity.',
  quotes: ['A visitor appreciated the friendly staff.'],
  nextSteps: ['Review restroom signage.'],
}

describe('processWeeklyReportJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropic)

    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.assertGlobalAiAvailable.mockResolvedValue(undefined)
    mocks.deferWeeklyReportExecution.mockResolvedValue(true)
    mocks.renewWeeklyReportExecution.mockResolvedValue(true)
    mocks.acquireWeeklyReportExecution.mockResolvedValue({
      state: 'acquired',
      leaseToken: 'report_lease_1',
    })
    mocks.acquireWeeklyReportRecoveryExecution.mockResolvedValue({
      state: 'acquired',
      leaseToken: 'report_lease_1',
    })
    mocks.reportUpdateMany.mockResolvedValue({ count: 1 })
    mocks.venueFindFirst.mockResolvedValue({ name: 'City Zoo', category: 'zoo' })
    mocks.sessionCount.mockResolvedValue(2)
    mocks.messageCount.mockResolvedValue(4)
    mocks.responseFindMany.mockResolvedValue([
      {
        questionText: 'What did you enjoy?',
        answerText: 'Friendly staff',
        isAiInvented: false,
      },
    ])
    mocks.questionFindMany.mockResolvedValue([
      { prompt: 'What did you enjoy?', questionType: 'TEXT' },
    ])
    mocks.noteFindMany.mockResolvedValue([{ note: 'Guest needed help finding the restroom.' }])
    mocks.messageFindMany.mockResolvedValue([{ content: 'Where are the restrooms?' }])
    mocks.aiUsageEventCreate.mockResolvedValue({})
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(validReport) }],
      usage: { input_tokens: 120, output_tokens: 50 },
    })
  })

  it('creates a draft and records tenant- and venue-attributed usage', async () => {
    await processWeeklyReportJob(payload, 'bull_job_1')

    expect(mocks.acquireWeeklyReportExecution).toHaveBeenCalledWith({
      reportId: 'report_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: new Date('2026-06-01T00:00:00.000Z'),
      weekEnd: new Date('2026-06-08T00:00:00.000Z'),
    })
    expect(mocks.writeJobRecord.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acquireWeeklyReportExecution.mock.invocationCallOrder[0] as number,
    )
    expect(mocks.venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { name: true, category: true },
    })
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6', max_tokens: 1_800 }),
      expect.objectContaining({ timeout: 30_000, signal: expect.any(AbortSignal) }),
    )
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'weekly-report',
        surface: 'worker',
        inputTokens: 120,
        outputTokens: 50,
        totalTokens: 170,
        success: true,
      }),
    })
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: expect.objectContaining({
        status: 'DRAFT',
        answerCount: 1,
        sessionCount: 2,
        content: expect.stringContaining('Sessions: 2 · Messages: 4'),
        error: null,
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fenced-releases its execution lease without recording failure when admission pauses', async () => {
    const pause = new GlobalAiAdmissionError('global-ai-paused')
    mocks.assertGlobalAiAvailable.mockRejectedValueOnce(pause)

    await expect(processWeeklyReportJob(payload)).rejects.toBe(pause)

    expect(mocks.deferWeeklyReportExecution).toHaveBeenCalledWith({
      reportId: 'report_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: new Date('2026-06-01T00:00:00.000Z'),
      weekEnd: new Date('2026-06-08T00:00:00.000Z'),
      leaseToken: 'report_lease_1',
    })
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('does not dispatch or settle report state after lease ownership is lost', async () => {
    mocks.renewWeeklyReportExecution.mockResolvedValueOnce(false)

    await expect(processWeeklyReportJob(payload)).rejects.toMatchObject({
      code: 'execution-lease-ownership-lost',
    })

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.reportUpdateMany).not.toHaveBeenCalled()
    expect(mocks.deferWeeklyReportExecution).not.toHaveBeenCalled()
  })

  it('uses an exact observed-token recovery claim without persisting the token', async () => {
    const observedLeaseToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    await processWeeklyReportJob(payload, 'bull_recovery_1', { observedLeaseToken })

    expect(mocks.acquireWeeklyReportExecution).not.toHaveBeenCalled()
    expect(mocks.acquireWeeklyReportRecoveryExecution).toHaveBeenCalledWith({
      reportId: 'report_1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      weekStart: new Date('2026-06-01T00:00:00.000Z'),
      weekEnd: new Date('2026-06-08T00:00:00.000Z'),
      observedLeaseToken,
    })
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'weekly-report-recovery',
        payload,
      }),
    )
    expect(JSON.stringify(mocks.writeJobRecord.mock.calls)).not.toContain(observedLeaseToken)
  })

  it('completes an ineligible recovery delivery without reads or provider work', async () => {
    mocks.acquireWeeklyReportRecoveryExecution.mockResolvedValueOnce({ state: 'ineligible' })

    await expect(
      processWeeklyReportJob(payload, 'bull_recovery_superseded', {
        observedLeaseToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).resolves.toBeUndefined()

    expect(mocks.venueFindFirst).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('fails before the provider call when the venue is not owned by the tenant', async () => {
    mocks.venueFindFirst.mockResolvedValueOnce(null)

    await expect(processWeeklyReportJob(payload)).rejects.toThrow('Venue venue_1 not found')

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
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

  it.each(['missing', 'terminal'] as const)(
    'completes a %s queue delivery without source or provider work',
    async (state) => {
      mocks.acquireWeeklyReportExecution.mockResolvedValueOnce({ state })
      await expect(processWeeklyReportJob(payload)).resolves.toBeUndefined()

      expect(mocks.reportUpdateMany).not.toHaveBeenCalled()
      expect(mocks.venueFindFirst).not.toHaveBeenCalled()
      expect(mocks.sessionCount).not.toHaveBeenCalled()
      expect(mocks.messageCount).not.toHaveBeenCalled()
      expect(mocks.responseFindMany).not.toHaveBeenCalled()
      expect(mocks.questionFindMany).not.toHaveBeenCalled()
      expect(mocks.noteFindMany).not.toHaveBeenCalled()
      expect(mocks.messageFindMany).not.toHaveBeenCalled()
      expect(anthropicCreate).not.toHaveBeenCalled()
      expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
        status: 'COMPLETE',
      })
    },
  )

  it('throws a fixed retryable error for an active lease without domain or provider work', async () => {
    mocks.acquireWeeklyReportExecution.mockResolvedValueOnce({ state: 'leased' })

    await expect(
      processWeeklyReportJob(payload, {
        bullJobId: 'bull_leased',
        attemptNumber: 1,
        maxAttempts: 6,
      }),
    ).rejects.toThrow('Weekly report generation is already in progress. Retry this job later.')

    expect(mocks.reportUpdateMany).not.toHaveBeenCalled()
    expect(mocks.venueFindFirst).not.toHaveBeenCalled()
    expect(mocks.sessionCount).not.toHaveBeenCalled()
    expect(mocks.messageCount).not.toHaveBeenCalled()
    expect(mocks.responseFindMany).not.toHaveBeenCalled()
    expect(mocks.questionFindMany).not.toHaveBeenCalled()
    expect(mocks.noteFindMany).not.toHaveBeenCalled()
    expect(mocks.messageFindMany).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
  })

  it('preserves fenced multi-block JSON parsing and defensive array truncation', async () => {
    const oversizeReport = {
      ...validReport,
      quotes: ['quote one', 'quote two', 'quote three', 'quote four'],
      nextSteps: ['step one', 'step two', 'step three'],
    }
    anthropicCreate.mockResolvedValueOnce({
      content: [
        { type: 'text', text: 'Report JSON follows.' },
        { type: 'text', text: `\`\`\`json\n${JSON.stringify(oversizeReport)}\n\`\`\`` },
      ],
      usage: { input_tokens: 120, output_tokens: 60 },
    })

    await processWeeklyReportJob(payload)

    const draftCall = mocks.reportUpdateMany.mock.calls.at(-1)?.[0] as {
      data: { content: string }
    }
    expect(draftCall.data.content).toContain('- "quote three"')
    expect(draftCall.data.content).not.toContain('quote four')
    expect(draftCall.data.content).toContain('2. step two')
    expect(draftCall.data.content).not.toContain('step three')
  })

  it('records observed usage and fails the report for malformed structured output', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"quotes":"not-an-array"}' }],
      usage: { input_tokens: 90, output_tokens: 15 },
    })

    await expect(processWeeklyReportJob(payload)).rejects.toThrow()

    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feature: 'weekly-report',
        success: false,
        errorCode: 'invalid-structured-output',
        inputTokens: 90,
        outputTokens: 15,
        totalTokens: 105,
      }),
    })
    const failureUsage = mocks.aiUsageEventCreate.mock.calls[0]?.[0]?.data as {
      estimatedCostUsd: number
    }
    expect(failureUsage.estimatedCostUsd).toBeGreaterThan(0)
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: expect.objectContaining({
        status: 'FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
  })

  it('leaves retryable provider failures to BullMQ without an inner retry', async () => {
    anthropicCreate.mockRejectedValue(
      Object.assign(new Error('provider unavailable'), { status: 503 }),
    )

    await expect(processWeeklyReportJob(payload)).rejects.toThrow('provider unavailable')

    expect(anthropicCreate).toHaveBeenCalledTimes(1)
    expect(mocks.aiUsageEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        feature: 'weekly-report',
        success: false,
        errorCode: 'provider-http-503',
        attempts: 1,
        totalTokens: 0,
      }),
    })
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
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

  it('preserves the provider failure when the exact FAILED write misses ownership state', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    anthropicCreate.mockRejectedValueOnce(providerError)
    mocks.reportUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processWeeklyReportJob(payload)).rejects.toMatchObject({
      name: 'AiGatewayError',
      message: 'provider unavailable',
      code: 'provider-http-503',
    })

    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: {
        status: 'FAILED',
        error: 'WEEKLY_REPORT_FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
  })

  it('preserves a stale DRAFT terminal miss and cannot overwrite the replacement owner', async () => {
    mocks.reportUpdateMany.mockResolvedValue({ count: 0 })

    await expect(processWeeklyReportJob(payload)).rejects.toThrow(
      'The weekly-report ownership state no longer matched.',
    )

    expect(mocks.reportUpdateMany).toHaveBeenCalledTimes(2)
    expect(mocks.reportUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: expect.objectContaining({
        status: 'DRAFT',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.reportUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: {
        status: 'FAILED',
        error: 'WEEKLY_REPORT_FAILED',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      },
    })
  })

  it('preserves the provider failure when the exact FAILED write rejects', async () => {
    const providerError = Object.assign(new Error('provider unavailable'), { status: 503 })
    anthropicCreate.mockRejectedValueOnce(providerError)
    mocks.reportUpdateMany.mockImplementation(async (params) => {
      if (params.data.status === 'FAILED') throw new Error('report database unavailable')
      return { count: 1 }
    })

    await expect(processWeeklyReportJob(payload)).rejects.toMatchObject({
      name: 'AiGatewayError',
      message: 'provider unavailable',
      code: 'provider-http-503',
    })
  })

  it('does not fail a valid report when usage persistence is unavailable', async () => {
    mocks.aiUsageEventCreate.mockRejectedValueOnce(new Error('usage database unavailable'))

    await expect(processWeeklyReportJob(payload)).resolves.toBeUndefined()

    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'report_1',
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        status: 'GENERATING',
        executionLeaseToken: 'report_lease_1',
      },
      data: expect.objectContaining({
        status: 'DRAFT',
        executionLeaseToken: null,
        executionLeaseExpiresAt: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('does not rewrite a drafted report when JobRecord completion persistence fails', async () => {
    mocks.updateJobRecord.mockRejectedValueOnce(new Error('job record unavailable'))

    await expect(processWeeklyReportJob(payload)).rejects.toThrow('job record unavailable')

    expect(mocks.reportUpdateMany).toHaveBeenCalledOnce()
    expect(mocks.reportUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ executionLeaseToken: 'report_lease_1' }),
        data: expect.objectContaining({ status: 'DRAFT' }),
      }),
    )
  })
})
