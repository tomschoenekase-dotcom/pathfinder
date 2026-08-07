import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  loggerError: vi.fn(),
}))

vi.mock('@pathfinder/config', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: mocks.loggerError, debug: vi.fn() },
}))

vi.mock('@pathfinder/db', () => ({
  db: { aiUsageEvent: { create: mocks.create } },
}))

import { createWorkerAiUsageSink } from './ai-usage'

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

  it('logs and resolves when persistence fails', async () => {
    mocks.create.mockRejectedValueOnce(new Error('database unavailable'))
    const sink = createWorkerAiUsageSink({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'analytics-topic-classifier',
    })

    await expect(sink(usage)).resolves.toBeUndefined()
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'workers.ai_usage.failed' }),
    )
  })
})
