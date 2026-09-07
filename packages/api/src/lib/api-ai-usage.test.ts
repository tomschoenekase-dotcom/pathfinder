import type { AiUsageRecord } from '@pathfinder/ai'
import { logger } from '@pathfinder/config'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const budgetMocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  settleExact: vi.fn(),
  settleAmbiguous: vi.fn(),
  release: vi.fn(),
  dispatch: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  reserveAiCostAttempt: budgetMocks.reserve,
  settleAiCostAttemptExact: budgetMocks.settleExact,
  settleAiCostAttemptAmbiguous: budgetMocks.settleAmbiguous,
  releaseUndispatchedAiCostAttempt: budgetMocks.release,
  markAiCostAttemptDispatched: budgetMocks.dispatch,
}))

vi.mock('@pathfinder/config', () => ({
  logger: { error: vi.fn() },
}))

import type { TRPCContext } from '../context'
import { createApiAiUsageRecorder } from './api-ai-usage'

const createUsageEvent = vi.fn()
const db = {
  aiUsageEvent: { create: createUsageEvent },
} as unknown as TRPCContext['db']

const usage: AiUsageRecord = {
  provider: 'openai',
  model: 'text-embedding-3-small',
  pricingVersion: '2026-08-01',
  usage: {
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 25,
    cacheReadInputTokens: 10,
  },
  estimatedCostUsd: 0.0123,
  latencyMs: 456,
  attempts: 2,
  success: true,
}

describe('API AI usage recorder', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('persists exact attribution and sums every token bucket', async () => {
    createUsageEvent.mockResolvedValueOnce({ id: 'usage_1' })
    const recorder = createApiAiUsageRecorder({
      db,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'venue-package-semantic-analysis',
      surface: 'venue-package-create-draft',
    })

    await recorder.sink(usage)

    expect(createUsageEvent).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
        feature: 'venue-package-semantic-analysis',
        capability: 'UNCLASSIFIED',
        fallbackUsed: false,
        surface: 'venue-package-create-draft',
        provider: 'openai',
        model: 'text-embedding-3-small',
        pricingVersion: '2026-08-01',
        usageObservationStatus: null,
        inputTokens: 100,
        outputTokens: 50,
        cacheCreationInputTokens: 25,
        cacheReadInputTokens: 10,
        totalTokens: 185,
        estimatedCostUsd: 0.0123,
        latencyMs: 456,
        attempts: 2,
        success: true,
      },
      select: { id: true },
    })
    expect(recorder.usageEventIds()).toEqual(['usage_1'])
    expect(recorder.persistenceFailed()).toBe(false)
  })

  it('persists provider error codes and returns usage ids in insertion order', async () => {
    createUsageEvent
      .mockResolvedValueOnce({ id: 'usage_1' })
      .mockResolvedValueOnce({ id: 'usage_2' })
      .mockResolvedValueOnce({ id: 'usage_3' })
    const recorder = createApiAiUsageRecorder({
      db,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'feature',
      surface: 'surface',
    })

    await recorder.sink({ ...usage, success: false, errorCode: 'provider-timeout' })
    await recorder.sink(usage)
    await recorder.sink({ ...usage, success: false, errorCode: 'UPSTREAM_SECRET_TOKEN' })

    expect(createUsageEvent.mock.calls[0]![0].data.errorCode).toBe('provider-timeout')
    expect(createUsageEvent.mock.calls[1]![0].data).not.toHaveProperty('errorCode')
    expect(createUsageEvent.mock.calls[2]![0].data.errorCode).toBe('provider-error')
    expect(JSON.stringify(createUsageEvent.mock.calls)).not.toContain('UPSTREAM_SECRET_TOKEN')
    expect(recorder.usageEventIds()).toEqual(['usage_1', 'usage_2', 'usage_3'])

    const returnedIds = recorder.usageEventIds()
    returnedIds.push('external-mutation')
    expect(recorder.usageEventIds()).toEqual(['usage_1', 'usage_2', 'usage_3'])
  })

  it('correlates Client Tochi usage without assigning a public visitor session', async () => {
    createUsageEvent.mockResolvedValueOnce({ id: 'usage_tochi' })
    const recorder = createApiAiUsageRecorder({
      db,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      clientAssistantTurnId: 'turn_1',
      feature: 'client-tochi',
      surface: 'client-portal',
    })

    await recorder.sink(usage)

    expect(createUsageEvent.mock.calls[0]![0].data).toMatchObject({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      clientAssistantTurnId: 'turn_1',
      feature: 'client-tochi',
      surface: 'client-portal',
    })
    expect(createUsageEvent.mock.calls[0]![0].data).not.toHaveProperty('sessionId')
    expect(recorder.usageEventIds()).toEqual(['usage_tochi'])
  })

  it('fails with a generic error and logs no persistence exception details', async () => {
    createUsageEvent.mockRejectedValueOnce(new Error('postgres host and secret detail'))
    const recorder = createApiAiUsageRecorder({
      db,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'feature',
      surface: 'surface',
    })

    await expect(recorder.sink(usage)).rejects.toThrow('AI usage persistence failed')

    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith({
      action: 'api.ai_usage.persistence_failed',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'feature',
      error: 'AI usage persistence failed',
    })
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'postgres host and secret detail',
    )
    expect(recorder.persistenceFailed()).toBe(true)
    expect(recorder.usageEventIds()).toEqual([])
  })

  it('forgets terminal reservations so stale local references cannot settle twice', async () => {
    budgetMocks.reserve.mockResolvedValue({
      id: 'reservation-1',
      budgetId: 'budget-1',
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      budgetEpoch: 1,
      invocationId: 'invocation-1',
      attemptNumber: 1,
      reservedUnits: 100n,
    })
    budgetMocks.settleExact.mockResolvedValue(undefined)
    const recorder = createApiAiUsageRecorder({
      db,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      feature: 'guest-chat',
      surface: 'guest',
    })
    const ref = await recorder.budgetGate.reserve({
      invocationId: 'invocation-1',
      attemptNumber: 1,
      provider: 'openai',
      model: 'model-1',
      pricingVersion: 'configured-price-v1',
      reservedUnits: 100n,
    })
    expect(ref).toEqual({ id: 'reservation-1', reservedUnits: 100n })
    await recorder.budgetGate.settleExact(ref!, 42n)
    await expect(recorder.budgetGate.settleExact(ref!, 42n)).rejects.toThrow(
      'AI cost reservation reference is unavailable',
    )
    expect(budgetMocks.settleExact).toHaveBeenCalledTimes(1)
  })
})
