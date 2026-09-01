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
