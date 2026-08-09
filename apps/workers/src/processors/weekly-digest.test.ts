import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AnthropicMessagesClient } from '@pathfinder/ai'
import type { WeeklyDigestJobPayload } from '@pathfinder/jobs'

const mocks = vi.hoisted(() => ({
  digestUpdateMany: vi.fn(),
  tenantFindUnique: vi.fn(),
  sessionFindMany: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  assertGlobalAiAvailable: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'test' },
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: vi.fn(),
  },
}))

vi.mock('@pathfinder/db', () => ({
  assertGlobalAiAvailable: mocks.assertGlobalAiAvailable,
  GlobalAiAdmissionError: class GlobalAiAdmissionError extends Error {
    name = 'GlobalAiAdmissionError'
    constructor(readonly code: string) {
      super('Global AI admission is unavailable')
    }
  },
  db: {
    weeklyDigest: { updateMany: mocks.digestUpdateMany },
    tenant: { findUnique: mocks.tenantFindUnique },
    visitorSession: { findMany: mocks.sessionFindMany },
  },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { _setAnthropicClientForTesting, processWeeklyDigestJob } from './weekly-digest'
import { GlobalAiAdmissionError } from '@pathfinder/db'

const anthropicCreate = vi.fn()
const mockAnthropic = { messages: { create: anthropicCreate } } as AnthropicMessagesClient

const payload: WeeklyDigestJobPayload = {
  tenantId: 'tenant_1',
  digestId: 'digest_1',
  weekStart: '2026-06-01T00:00:00.000Z',
  weekEnd: '2026-06-08T00:00:00.000Z',
}

const validInsights = [
  {
    type: 'trend',
    title: 'Morning traffic increased',
    body: 'Three sessions asked about opening times.',
  },
  {
    type: 'confusion',
    title: 'Restrooms were hard to find',
    body: 'Two guests requested restroom directions.',
  },
  {
    type: 'recommendation',
    title: 'Improve entrance signage',
    body: 'Add a wayfinding sign near the entrance.',
  },
]

function makeSessions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `session_${index + 1}`,
    startedAt: new Date(`2026-06-0${index + 1}T10:00:00.000Z`),
    lastActiveAt: new Date(`2026-06-0${index + 1}T10:05:00.000Z`),
    venue: { name: 'City Zoo', category: 'zoo' },
    messages: [
      {
        role: 'user' as const,
        content: `private guest message ${index + 1}`,
        createdAt: new Date(`2026-06-0${index + 1}T10:01:00.000Z`),
      },
    ],
  }))
}

describe('processWeeklyDigestJob', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    _setAnthropicClientForTesting(mockAnthropic)
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.assertGlobalAiAvailable.mockResolvedValue(undefined)
    mocks.digestUpdateMany.mockResolvedValue({ count: 1 })
    mocks.tenantFindUnique.mockResolvedValue({ name: 'Example Tenant' })
    mocks.sessionFindMany.mockResolvedValue(makeSessions(5))
    anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ insights: validInsights }) }],
      usage: { input_tokens: 120, output_tokens: 50 },
    })
  })

  it('completes insufficient data without calling the provider', async () => {
    mocks.sessionFindMany.mockResolvedValueOnce(makeSessions(4))

    await processWeeklyDigestJob(payload, {
      bullJobId: 'bull_1',
      attemptNumber: 1,
      maxAttempts: 3,
    })

    expect(anthropicCreate).not.toHaveBeenCalled()
    expect(mocks.digestUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'digest_1', tenantId: 'tenant_1' },
      data: {
        status: 'COMPLETE',
        sessionCount: 4,
        messageCount: 4,
        insights: [],
        generatedAt: expect.any(Date),
      },
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('fenced-restores PENDING without recording failure when admission pauses', async () => {
    const pause = new GlobalAiAdmissionError('global-ai-paused')
    mocks.assertGlobalAiAvailable.mockRejectedValueOnce(pause)

    await expect(processWeeklyDigestJob(payload)).rejects.toBe(pause)

    expect(mocks.digestUpdateMany).toHaveBeenNthCalledWith(2, {
      where: { id: 'digest_1', tenantId: 'tenant_1', status: 'PROCESSING' },
      data: { status: 'PENDING' },
    })
    expect(mocks.updateJobRecord).not.toHaveBeenCalled()
    expect(anthropicCreate).not.toHaveBeenCalled()
  })

  it('accepts a valid structured response and completes the digest', async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [
        {
          type: 'text',
          text: `\`\`\`json\n${JSON.stringify({ insights: validInsights })}\n\`\`\``,
        },
      ],
      usage: { input_tokens: 120, output_tokens: 50 },
    })

    await processWeeklyDigestJob(payload)

    expect(anthropicCreate).toHaveBeenCalledWith(
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1_200,
        system: [],
        messages: [
          {
            role: 'user',
            content: expect.stringContaining('"sessionId": "session_1"'),
          },
        ],
      },
      { timeout: 30_000 },
    )
    expect(mocks.assertGlobalAiAvailable).toHaveBeenCalledTimes(2)
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.weekly-digest.ai-usage-unattributed',
        tenantId: 'tenant_1',
        digestId: 'digest_1',
        inputTokens: 120,
        outputTokens: 50,
        success: true,
      }),
    )
    expect(mocks.digestUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'digest_1', tenantId: 'tenant_1' },
      data: {
        status: 'COMPLETE',
        sessionCount: 5,
        messageCount: 5,
        insights: validInsights,
        generatedAt: expect.any(Date),
      },
    })
    expect(mocks.updateJobRecord).toHaveBeenLastCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it.each([
    ['plain malformed output', 'not-json'],
    ['fenced schema-invalid output', '```json\n{"insights":[]}\n```'],
  ])('marks the digest and job record failed for %s', async (_label, responseText) => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: 'text', text: responseText }],
      usage: { input_tokens: 120, output_tokens: 50 },
    })

    await expect(
      processWeeklyDigestJob(payload, {
        bullJobId: 'bull_failed',
        attemptNumber: 2,
        maxAttempts: 3,
      }),
    ).rejects.toThrow()

    expect(mocks.updateJobRecord).toHaveBeenCalledWith(
      'job_record_1',
      expect.objectContaining({
        status: 'FAILED',
        attemptNumber: 2,
        maxAttempts: 3,
        failureDisposition: 'RETRY_ELIGIBLE',
      }),
    )
    expect(mocks.digestUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'digest_1', tenantId: 'tenant_1' },
      data: { status: 'FAILED' },
    })
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.weekly-digest.ai-usage-unattributed',
        success: false,
        errorCode: 'invalid-structured-output',
      }),
    )
  })

  it('marks the digest failed when the provider rejects', async () => {
    anthropicCreate.mockRejectedValueOnce(new Error('provider unavailable'))

    await expect(
      processWeeklyDigestJob(payload, {
        bullJobId: 'bull_exhausted',
        attemptNumber: 3,
        maxAttempts: 3,
      }),
    ).rejects.toThrow('provider unavailable')

    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'provider unavailable',
      attemptNumber: 3,
      maxAttempts: 3,
      failureDisposition: 'ATTEMPTS_EXHAUSTED',
    })
    expect(mocks.digestUpdateMany).toHaveBeenLastCalledWith({
      where: { id: 'digest_1', tenantId: 'tenant_1' },
      data: { status: 'FAILED' },
    })
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.weekly-digest.ai-usage-unattributed',
        success: false,
        errorCode: 'provider-error',
      }),
    )
  })

  it('scopes every source read to the tenant and does not log session content', async () => {
    await processWeeklyDigestJob(payload)

    expect(mocks.tenantFindUnique).toHaveBeenCalledWith({
      where: { id: 'tenant_1' },
      select: { name: true },
    })
    expect(mocks.sessionFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        messages: {
          some: {
            tenantId: 'tenant_1',
            createdAt: {
              gte: new Date('2026-06-01T00:00:00.000Z'),
              lte: new Date('2026-06-08T00:00:00.000Z'),
            },
          },
        },
      },
      orderBy: { startedAt: 'asc' },
      select: expect.objectContaining({
        messages: expect.objectContaining({
          where: {
            tenantId: 'tenant_1',
            createdAt: {
              gte: new Date('2026-06-01T00:00:00.000Z'),
              lte: new Date('2026-06-08T00:00:00.000Z'),
            },
          },
        }),
      }),
    })

    const logs = JSON.stringify([
      ...mocks.loggerInfo.mock.calls,
      ...mocks.loggerWarn.mock.calls,
      ...mocks.loggerError.mock.calls,
    ])
    expect(logs).not.toContain('private guest message')
    expect(logs).toContain('tenant_1')
    expect(logs).toContain('digest_1')
  })
})
