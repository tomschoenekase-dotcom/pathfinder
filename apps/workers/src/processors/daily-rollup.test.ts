import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  venueFindMany: vi.fn(),
  visitorSessionCount: vi.fn(),
  messageCount: vi.fn(),
  messageFindMany: vi.fn(),
  placeFindMany: vi.fn(),
  usageGroupBy: vi.fn(),
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
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: {
    venue: { findMany: mocks.venueFindMany },
    visitorSession: { count: mocks.visitorSessionCount },
    message: { count: mocks.messageCount, findMany: mocks.messageFindMany },
    place: { findMany: mocks.placeFindMany },
    aiUsageEvent: { groupBy: mocks.usageGroupBy },
    $transaction: mocks.transaction,
  },
  withTenantIsolationBypass: mocks.withTenantIsolationBypass,
  writeJobRecord: mocks.writeJobRecord,
  updateJobRecord: mocks.updateJobRecord,
}))

import { buildAiCostRollups, processDailyRollupJob } from './daily-rollup'

const targetDate = new Date('2026-08-06T00:00:00.000Z')

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
        totalTokens: true,
        estimatedCostUsd: true,
      },
    })
    expect(mocks.dailyDeleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant_1',
        date: dayWhere.createdAt,
        metric: {
          in: ['sessions', 'messages', 'unique_place_mentions', 'place_mentions'],
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

  it('fails the job record when transactional replacement fails', async () => {
    mocks.transaction.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(
      processDailyRollupJob({ tenantId: 'tenant_1', date: targetDate.toISOString() }),
    ).rejects.toThrow('database unavailable')
    expect(mocks.updateJobRecord).toHaveBeenCalledWith('job_record_1', {
      status: 'FAILED',
      error: 'database unavailable',
    })
  })
})
