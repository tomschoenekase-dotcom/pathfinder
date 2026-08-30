import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  venueFindMany: vi.fn(),
  visitorSessionCount: vi.fn(),
  messageCount: vi.fn(),
  messageFindMany: vi.fn(),
  placeFindMany: vi.fn(),
  usageGroupBy: vi.fn(),
  analyticsEventFindMany: vi.fn(),
  dailyDeleteMany: vi.fn(),
  dailyCreateMany: vi.fn(),
  costDeleteMany: vi.fn(),
  costCreateMany: vi.fn(),
  transaction: vi.fn(),
  withTenantIsolationBypass: vi.fn(),
  writeJobRecord: vi.fn(),
  updateJobRecord: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  env: { RAILWAY_ENVIRONMENT: 'staging' },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findMany: mocks.venueFindMany },
    visitorSession: { count: mocks.visitorSessionCount },
    message: { count: mocks.messageCount, findMany: mocks.messageFindMany },
    place: { findMany: mocks.placeFindMany },
    aiUsageEvent: { groupBy: mocks.usageGroupBy },
    analyticsEvent: { findMany: mocks.analyticsEventFindMany },
    $transaction: mocks.transaction,
  },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import {
  buildAiCostRollups,
  buildChatReliabilityRollups,
  processDailyRollupJob,
} from './daily-rollup'

const targetDate = new Date('2026-08-06T00:00:00.000Z')

describe('buildChatReliabilityRollups', () => {
  it('computes privacy-safe fallback counts, basis points, and nearest-rank p50/p95 timings', () => {
    const events: Array<{ eventType: string; metadata: Record<string, unknown> }> = [
      ...Array.from({ length: 20 }, (_, index) => ({
        eventType: 'message.received',
        metadata: {
          fallback: index < 3,
          embeddingMs: index + 1,
          retrievalMs: 10,
          promptAssemblyMs: 2,
          modelMs: (index + 1) * 10,
          persistenceMs: 3,
          totalMs: (index + 1) * 20,
        },
      })),
    ]
    const rows = buildChatReliabilityRollups({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      date: targetDate,
      events,
    })
    expect(rows).toHaveLength(15)

    const values = Object.fromEntries(rows.map((row) => [row.metric, row.value]))
    expect(values).toMatchObject({
      chat_responses: 20,
      chat_fallbacks: 3,
      chat_fallback_rate_bps: 1500,
      chat_embedding_p50_ms: 10,
      chat_embedding_p95_ms: 19,
      chat_model_p50_ms: 100,
      chat_model_p95_ms: 190,
      chat_total_p50_ms: 200,
      chat_total_p95_ms: 380,
    })
    for (const stage of [
      'embedding',
      'retrieval',
      'prompt_assembly',
      'model',
      'persistence',
      'total',
    ]) {
      expect(values).toHaveProperty(`chat_${stage}_p50_ms`)
      expect(values).toHaveProperty(`chat_${stage}_p95_ms`)
    }
  })

  it('omits unsampled timing percentiles and reports explicit zero response counts', () => {
    const rows = buildChatReliabilityRollups({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      date: targetDate,
      events: [],
    })
    expect(rows.map((row) => row.metric)).toEqual([
      'chat_responses',
      'chat_fallbacks',
      'chat_fallback_rate_bps',
    ])
    expect(rows.every((row) => row.value === 0)).toBe(true)
  })

  it('preserves a legitimate zero-millisecond sample while omitting malformed stages', () => {
    const rows = buildChatReliabilityRollups({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      date: targetDate,
      events: [
        {
          eventType: 'message.received',
          metadata: { totalMs: 0, modelMs: -1, retrievalMs: 'not-a-number' },
        },
      ],
    })
    const values = Object.fromEntries(rows.map((row) => [row.metric, row.value]))

    expect(values.chat_total_p50_ms).toBe(0)
    expect(values.chat_total_p95_ms).toBe(0)
    expect(values).not.toHaveProperty('chat_model_p50_ms')
    expect(values).not.toHaveProperty('chat_retrieval_p95_ms')
  })
})

describe('buildAiCostRollups', () => {
  it('groups by venue and feature with exact eight-decimal cost arithmetic', () => {
    const rows = buildAiCostRollups({
      tenantId: 'tenant_1',
      date: targetDate,
      events: [
        {
          venueId: 'venue_1',
          feature: 'guest-chat',
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 2,
          cacheCreationInputTokens: 3,
          cacheReadInputTokens: 4,
          audioInputTokens: 2,
          audioOutputTokens: 1,
          cachedAudioInputTokens: 1,
          totalTokens: 19,
          estimatedCostUsd: '0.10000001',
          success: true,
        },
        {
          venueId: 'venue_1',
          feature: 'guest-chat',
          requestCount: 1,
          inputTokens: 5,
          outputTokens: 1,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 2,
          audioInputTokens: 3,
          audioOutputTokens: 2,
          cachedAudioInputTokens: 1,
          totalTokens: 8,
          estimatedCostUsd: '2e-8',
          success: false,
        },
        {
          venueId: 'venue_2',
          feature: 'place-embedding',
          requestCount: 1,
          inputTokens: 7,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          audioInputTokens: 0,
          audioOutputTokens: 0,
          cachedAudioInputTokens: 0,
          totalTokens: 7,
          estimatedCostUsd: 0.00000001,
          success: true,
        },
      ],
    })

    expect(rows).toEqual([
      {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        date: targetDate,
        feature: 'guest-chat',
        requestCount: 2,
        successfulRequestCount: 1,
        failedRequestCount: 1,
        inputTokens: 15,
        outputTokens: 3,
        cacheCreationInputTokens: 3,
        cacheReadInputTokens: 6,
        audioInputTokens: 5,
        audioOutputTokens: 3,
        cachedAudioInputTokens: 2,
        totalTokens: 27,
        estimatedCostUsd: '0.10000003',
      },
      {
        tenantId: 'tenant_1',
        venueId: 'venue_2',
        date: targetDate,
        feature: 'place-embedding',
        requestCount: 1,
        successfulRequestCount: 1,
        failedRequestCount: 0,
        inputTokens: 7,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        audioInputTokens: 0,
        audioOutputTokens: 0,
        cachedAudioInputTokens: 0,
        totalTokens: 7,
        estimatedCostUsd: '0.00000001',
      },
    ])
  })

  it('rejects precision that the database decimal cannot represent exactly', () => {
    expect(() =>
      buildAiCostRollups({
        tenantId: 'tenant_1',
        date: targetDate,
        events: [
          {
            venueId: 'venue_1',
            feature: 'guest-chat',
            requestCount: 1,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            audioInputTokens: 0,
            audioOutputTokens: 0,
            cachedAudioInputTokens: 0,
            totalTokens: 0,
            estimatedCostUsd: '0.000000001',
            success: true,
          },
        ],
      }),
    ).toThrow('AI cost exceeds 8 decimal places')
  })
})

describe('processDailyRollupJob AI cost rollups', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.withTenantIsolationBypass.mockImplementation((fn: () => unknown) => fn())
    mocks.writeJobRecord.mockResolvedValue('job_record_1')
    mocks.updateJobRecord.mockResolvedValue(undefined)
    mocks.venueFindMany.mockResolvedValue([])
    mocks.usageGroupBy.mockResolvedValue([])
    mocks.analyticsEventFindMany.mockResolvedValue([])
    mocks.dailyDeleteMany.mockResolvedValue({ count: 0 })
    mocks.dailyCreateMany.mockResolvedValue({ count: 0 })
    mocks.costDeleteMany.mockResolvedValue({ count: 0 })
    mocks.costCreateMany.mockResolvedValue({ count: 0 })
    mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn({
        dailyRollup: {
          deleteMany: mocks.dailyDeleteMany,
          createMany: mocks.dailyCreateMany,
        },
        aiUsageDailyRollup: {
          deleteMany: mocks.costDeleteMany,
          createMany: mocks.costCreateMany,
        },
      }),
    )
  })

  it('reads only the tenant UTC day and atomically replaces its cost rows', async () => {
    mocks.usageGroupBy.mockResolvedValue([
      {
        venueId: 'venue_1',
        feature: 'guest-chat',
        success: true,
        _count: { _all: 2 },
        _sum: {
          inputTokens: 100,
          outputTokens: 20,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          audioInputTokens: 20,
          audioOutputTokens: 10,
          cachedAudioInputTokens: 5,
          totalTokens: 120,
          estimatedCostUsd: '0.00030000',
        },
      },
      {
        venueId: 'venue_1',
        feature: 'guest-chat',
        success: false,
        _count: { _all: 1 },
        _sum: {
          inputTokens: 5,
          outputTokens: 0,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          audioInputTokens: 1,
          audioOutputTokens: 0,
          cachedAudioInputTokens: 0,
          totalTokens: 5,
          estimatedCostUsd: '0.00000001',
        },
      },
    ])

    await processDailyRollupJob(
      { tenantId: 'tenant_1', date: '2026-08-06T17:42:00.000Z' },
      'bull_1',
    )

    const dayWhere = {
      tenantId: 'tenant_1',
      createdAt: {
        gte: new Date('2026-08-06T00:00:00.000Z'),
        lt: new Date('2026-08-07T00:00:00.000Z'),
      },
    }
    expect(mocks.usageGroupBy).toHaveBeenCalledWith({
      by: ['venueId', 'feature', 'success'],
      where: dayWhere,
      _count: { _all: true },
      _sum: {
        inputTokens: true,
        outputTokens: true,
        cacheCreationInputTokens: true,
        cacheReadInputTokens: true,
        audioInputTokens: true,
        audioOutputTokens: true,
        cachedAudioInputTokens: true,
        totalTokens: true,
        estimatedCostUsd: true,
      },
    })
    expect(mocks.dailyDeleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        date: dayWhere.createdAt,
        metric: {
          in: [
            'sessions',
            'messages',
            'unique_place_mentions',
            'place_mentions',
            'chat_responses',
            'chat_fallbacks',
            'chat_fallback_rate_bps',
            'chat_embedding_p50_ms',
            'chat_embedding_p95_ms',
            'chat_retrieval_p50_ms',
            'chat_retrieval_p95_ms',
            'chat_prompt_assembly_p50_ms',
            'chat_prompt_assembly_p95_ms',
            'chat_model_p50_ms',
            'chat_model_p95_ms',
            'chat_persistence_p50_ms',
            'chat_persistence_p95_ms',
            'chat_total_p50_ms',
            'chat_total_p95_ms',
          ],
        },
      },
    })
    expect(mocks.costDeleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        date: dayWhere.createdAt,
      },
    })
    expect(mocks.costCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          feature: 'guest-chat',
          requestCount: 3,
          successfulRequestCount: 2,
          failedRequestCount: 1,
          audioInputTokens: 21,
          audioOutputTokens: 10,
          cachedAudioInputTokens: 5,
          totalTokens: 125,
          estimatedCostUsd: '0.00030001',
        }),
      ],
    })
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', {
      status: 'COMPLETE',
    })
  })

  it('deletes stale cost rows without inserting when the day has no usage', async () => {
    await processDailyRollupJob({ tenantId: 'tenant_1', date: targetDate.toISOString() })

    expect(mocks.costDeleteMany).toHaveBeenCalledOnce()
    expect(mocks.costCreateMany).not.toHaveBeenCalled()
  })

  it('reads server chat events in the tenant venue day and persists reliability metrics', async () => {
    mocks.venueFindMany.mockResolvedValue([{ id: 'venue_1' }])
    mocks.visitorSessionCount.mockResolvedValue(1)
    mocks.messageCount.mockResolvedValue(2)
    mocks.messageFindMany.mockResolvedValue([])
    mocks.placeFindMany.mockResolvedValue([])
    mocks.analyticsEventFindMany.mockResolvedValue([
      { eventType: 'message.received', metadata: { totalMs: 120, modelMs: 80 } },
      { eventType: 'message.received', metadata: { totalMs: 240, modelMs: 190 } },
      { eventType: 'message.received', metadata: { fallback: true, totalMs: 200, modelMs: 150 } },
    ])

    await processDailyRollupJob({ tenantId: 'tenant_1', date: targetDate.toISOString() })

    expect(mocks.analyticsEventFindMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        eventType: 'message.received',
        occurredAt: {
          gte: new Date('2026-08-06T00:00:00.000Z'),
          lt: new Date('2026-08-07T00:00:00.000Z'),
        },
      },
      select: { eventType: true, metadata: true },
    })
    expect(mocks.dailyCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({ venueId: 'venue_1', metric: 'chat_responses', value: 3 }),
        expect.objectContaining({ venueId: 'venue_1', metric: 'chat_fallbacks', value: 1 }),
        expect.objectContaining({
          venueId: 'venue_1',
          metric: 'chat_fallback_rate_bps',
          value: 3333,
        }),
        expect.objectContaining({ venueId: 'venue_1', metric: 'chat_total_p50_ms', value: 200 }),
        expect.objectContaining({ venueId: 'venue_1', metric: 'chat_total_p95_ms', value: 240 }),
      ]),
    })
  })

  it('fails the job record when transactional replacement fails', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(
      processDailyRollupJob(
        { tenantId: 'tenant_1', date: targetDate.toISOString() },
        { bullJobId: 'daily_job_1', attemptNumber: 1, maxAttempts: 6 },
      ),
    ).rejects.toThrow('database unavailable')
    expect(mocks.writeJobRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        bullJobId: 'daily_job_1',
        status: 'RUNNING',
        attemptNumber: 1,
        maxAttempts: 6,
      }),
    )
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', {
      status: 'FAILED',
      attemptNumber: 1,
      maxAttempts: 6,
      failureDisposition: 'RETRY_ELIGIBLE',
    })
  })
})
