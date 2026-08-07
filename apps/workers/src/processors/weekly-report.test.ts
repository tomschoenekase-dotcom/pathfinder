import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { WeeklyReportJobPayload } from '@pathfinder/jobs'

const mocks = vi.hoisted(() => ({
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
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
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setAnthropicClientForTesting, processWeeklyReportJob } from './weekly-report'

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

    expect(mocks.venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { name: true, category: true },
    })
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6', max_tokens: 1_800 }),
      { timeout: 30_000 },
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
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      data: expect.objectContaining({
        status: 'DRAFT',
        answerCount: 1,
        sessionCount: 2,
        content: expect.stringContaining('Sessions: 2 · Messages: 4'),
        error: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fails before the provider call when the venue is not owned by the tenant', async () => {
    mocks.venueFindFirst.mockResolvedValueOnce(null)

    await expect(processWeeklyReportJob(payload)).rejects.toThrow('Venue venue_1 not found')

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
  })

  it('rejects a queue payload that does not match the report tenant and venue', async () => {
    mocks.reportUpdateMany.mockResolvedValueOnce({ count: 0 })

    await expect(processWeeklyReportJob(payload)).rejects.toThrow(
      'Report report_1 not found for tenant tenant_1 and venue venue_1',
    )

    expect(mocks.reportUpdateMany).toHaveBeenCalledTimes(1)
    expect(mocks.writeJobRecord).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
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
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
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
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({ status: 'FAILED' }),
    )
  })

  it('does not fail a valid report when usage persistence is unavailable', async () => {
    mocks.aiUsageEventCreate.mockRejectedValueOnce(new Error('usage database unavailable'))

    await expect(processWeeklyReportJob(payload)).resolves.toBeUndefined()

    expect(mocks.reportUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'report_1', tenantId: 'tenant_1', venueId: 'venue_1' },
      data: expect.objectContaining({ status: 'DRAFT' }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })
})
