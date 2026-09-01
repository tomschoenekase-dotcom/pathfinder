import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  loggerError: vi.fn(),
  reserve: vi.fn(),
  markDispatched: vi.fn(),
  settleExact: vi.fn(),
  settleAmbiguous: vi.fn(),
  releaseUndispatched: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError, debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: { aiUsageEvent: { create: mocks.create } },
  reserveAiCostAttempt: mocks.reserve,
  markAiCostAttemptDispatched: mocks.markDispatched,
  settleAiCostAttemptExact: mocks.settleExact,
  settleAiCostAttemptAmbiguous: mocks.settleAmbiguous,
  releaseUndispatchedAiCostAttempt: mocks.releaseUndispatched,
}))

import {
  createTenantWideWorkerAiBudgetGate,
  createTenantWideWorkerAiUsageSink,
  createWorkerAiBudgetGate,
  createWorkerAiUsageSink,
} from './ai-usage'

const usage = {
  provider: 'anthropic' as const,
  model: 'claude-haiku-4-5-20251001',
  pricingVersion: 'anthropic-public-2026-08-07',
  usage: {
    inputTokens: 20,
    outputTokens: 10,
    cacheCreationInputTokens: 4,
    cacheReadInputTokens: 3,
  },
  estimatedCostUsd: 0.0000773,
  latencyMs: 100,
  attempts: 1,
  success: true,
}

describe('createWorkerAiUsageSink', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('writes cache-inclusive, tenant-and-venue-attributed usage', async () => {
    mocks.create.mockResolvedValueOnce({})
    const sink = createWorkerAiUsageSink({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'analytics-topic-classifier',
    })

    await sink(usage)

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'analytics-topic-classifier',
        surface: 'worker',
        totalTokens: 37,
        success: true,
      }),
    })
  })

  it('writes explicitly tenant-wide usage without fabricating a venue', async () => {
    mocks.create.mockResolvedValueOnce({})
    const sink = createTenantWideWorkerAiUsageSink({
      tenantId: 'tenant_1',
      feature: 'weekly-digest',
    })

    await sink(usage)

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: 'tenant_1',
        feature: 'weekly-digest',
        surface: 'worker',
      }),
    })
    expect(mocks.create.mock.calls[0]?.[0]?.data).not.toHaveProperty('venueId')
  })

  it('normalizes arbitrary usage failure codes before persistence', async () => {
    mocks.create.mockResolvedValueOnce({})
    const sink = createWorkerAiUsageSink({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'analytics-topic-classifier',
    })

    await sink({ ...usage, success: false, errorCode: 'UPSTREAM_SECRET_TOKEN' })

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'provider-error' }),
      }),
    )
    expect(JSON.stringify(mocks.create.mock.calls)).not.toContain('UPSTREAM_SECRET_TOKEN')
  })

  it('persists audio token details without double-counting total tokens', async () => {
    mocks.create.mockResolvedValueOnce({})
    const sink = createWorkerAiUsageSink({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'media-ingestion',
    })

    await sink({
      ...usage,
      provider: 'openai',
      usage: {
        inputTokens: 80,
        outputTokens: 12,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        audioInputTokens: 80,
        audioOutputTokens: 0,
        cachedAudioInputTokens: 0,
      },
    })

    expect(mocks.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        audioInputTokens: 80,
        audioOutputTokens: 0,
        cachedAudioInputTokens: 0,
        totalTokens: 92,
      }),
    })
  })

  it('logs and resolves when persistence fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('database host and secret detail'))
    const sink = createWorkerAiUsageSink({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'analytics-topic-classifier',
    })

    await expect(sink(usage)).resolves.toBeUndefined()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'workers.ai_usage.failed',
        error: 'AI usage persistence failed',
      }),
    )
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(
      'database host and secret detail',
    )
  })
})

describe('createWorkerAiBudgetGate', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('forgets a reservation only after an exact terminal settlement succeeds', async () => {
    const reservation = {
      id: 'reservation_1',
      budgetId: 'budget_1',
      budgetEpoch: 1,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      invocationId: 'invocation_1',
      attemptNumber: 1,
      feature: 'media-ingestion',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      pricingVersion: 'openai-public-2026-09-01',
      reservedUnits: 65_040_000n,
    }
    mocks.reserve.mockResolvedValueOnce(reservation)
    mocks.settleExact.mockResolvedValueOnce(undefined)
    const gate = createWorkerAiBudgetGate({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'media-ingestion',
    })

    const ref = await gate.reserve({
      invocationId: 'invocation_1',
      attemptNumber: 1,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      pricingVersion: 'openai-public-2026-09-01',
      reservedUnits: 65_040_000n,
    })
    expect(ref).not.toBeNull()
    await gate.settleExact(ref!, 5_640n)

    await expect(gate.settleExact(ref!, 5_640n)).rejects.toThrow(
      'AI cost reservation reference is unavailable',
    )
    expect(mocks.settleExact).toHaveBeenCalledOnce()
  })

  it('retains a reservation when durable settlement fails', async () => {
    const reservation = {
      id: 'reservation_2',
      budgetId: 'budget_1',
      budgetEpoch: 1,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      invocationId: 'invocation_2',
      attemptNumber: 1,
      feature: 'media-ingestion',
      provider: 'openai',
      model: 'gpt-5.6-luna',
      pricingVersion: 'openai-public-2026-09-01',
      reservedUnits: 65_040_000n,
    }
    mocks.reserve.mockResolvedValueOnce(reservation)
    mocks.settleAmbiguous
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined)
    const gate = createWorkerAiBudgetGate({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'media-ingestion',
    })
    const ref = await gate.reserve({
      invocationId: 'invocation_2',
      attemptNumber: 1,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      pricingVersion: 'openai-public-2026-09-01',
      reservedUnits: 65_040_000n,
    })

    await expect(gate.settleAmbiguous(ref!)).rejects.toThrow('database unavailable')
    await expect(gate.settleAmbiguous(ref!)).resolves.toBeUndefined()
    expect(mocks.settleAmbiguous).toHaveBeenCalledTimes(2)
  })

  it('reserves tenant-wide spend with an explicit null venue scope', async () => {
    const reservation = {
      id: 'reservation_tenant_wide',
      budgetId: 'budget_1',
      budgetEpoch: 1,
      tenantId: 'tenant_1',
      venueId: null,
      invocationId: 'invocation_tenant_wide',
      attemptNumber: 1,
      feature: 'weekly-digest',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      pricingVersion: 'anthropic-public-2026-08-07',
      reservedUnits: 61_800_000n,
    }
    mocks.reserve.mockResolvedValueOnce(reservation)
    const gate = createTenantWideWorkerAiBudgetGate({
      tenantId: 'tenant_1',
      feature: 'weekly-digest',
    })

    await expect(
      gate.reserve({
        invocationId: 'invocation_tenant_wide',
        attemptNumber: 1,
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        pricingVersion: 'anthropic-public-2026-08-07',
        reservedUnits: 61_800_000n,
      }),
    ).resolves.toEqual({ id: 'reservation_tenant_wide', reservedUnits: 61_800_000n })
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({
          tenantId: 'tenant_1',
          venueId: null,
          feature: 'weekly-digest',
        }),
      }),
    )
  })
})
