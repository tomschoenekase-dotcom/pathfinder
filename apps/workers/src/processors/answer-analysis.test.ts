import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { AnswerAnalysisJobPayload } from '@pathfinder/jobs'

const mocks = vi.hoisted(() => ({
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    answerAnalysisSnapshot: { updateMany: mocks.snapshotUpdateMany },
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

    expect(mocks.venueFindFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { name: true },
    })
    expect(anthropicCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6', max_tokens: 1_500 }),
      { timeout: 30_000 },
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
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({
        status: 'COMPLETE',
        summary: validSummary,
        answerCount: 1,
        error: null,
      }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })

  it('fails before the provider call when the venue is not owned by the tenant', async () => {
    mocks.venueFindFirst.mockResolvedValueOnce(null)

    await expect(processAnswerAnalysisJob(payload)).rejects.toThrow(
      'Venue venue_1 not found for tenant tenant_1',
    )

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.aiUsageEventCreate).not.toHaveBeenCalled()
    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
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
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({
        status: 'COMPLETE',
        answerCount: 0,
        summary: expect.objectContaining({ sampleSizeCaveat: expect.any(String) }),
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
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
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
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({ status: 'FAILED' }),
    })
  })

  it('does not fail a successful analysis when usage persistence is unavailable', async () => {
    mocks.aiUsageEventCreate.mockRejectedValueOnce(new Error('usage database unavailable'))

    await expect(processAnswerAnalysisJob(payload)).resolves.toBeUndefined()

    expect(mocks.snapshotUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'snapshot_1', tenantId: 'tenant_1' },
      data: expect.objectContaining({ status: 'COMPLETE', summary: validSummary }),
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', { status: 'COMPLETE' })
  })
})
