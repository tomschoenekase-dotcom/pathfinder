import { describe, expect, it, vi } from 'vitest'

const moduleMocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  record: vi.fn(),
  recordDeclared: vi.fn(),
  recordQueue: vi.fn(),
}))

vi.mock('@pathfinder/db', () => ({
  inspectDeclaredOperationalUsage: vi.fn(),
  recordDeclaredOperationalUsageSnapshot: moduleMocks.recordDeclared,
  recordOperationalUsageEvidenceAction: moduleMocks.record,
  recordQueueOperationalUsageSnapshot: moduleMocks.recordQueue,
}))

vi.mock('@pathfinder/jobs', () => ({
  inspectQueueOperationalSnapshot: moduleMocks.inspect,
}))

import { startOperationalUsageObserver } from './operational-usage-observer'

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    observedAt: new Date('2026-08-25T08:00:00.000Z'),
    coverage: { expectedQueues: 2, observedQueues: 2, complete: true },
    totalDepth: 3,
    totalFailed: 1,
    pausedQueues: 0,
    jobSchedulers: 2,
    oldestAgeMs: 12_000,
    queues: [
      {
        name: 'alpha',
        counts: {
          waiting: 2,
          active: 0,
          delayed: 0,
          prioritized: 0,
          waitingChildren: 0,
          failed: 1,
        },
        depth: 2,
        failed: 1,
        paused: false,
        jobSchedulers: 1,
        oldestQueuedAt: new Date('2026-08-25T07:59:48.000Z'),
        oldestAgeMs: 12_000,
      },
      {
        name: 'beta',
        counts: {
          waiting: 1,
          active: 0,
          delayed: 0,
          prioritized: 0,
          waitingChildren: 0,
          failed: 0,
        },
        depth: 1,
        failed: 0,
        paused: false,
        jobSchedulers: 1,
        oldestQueuedAt: null,
        oldestAgeMs: null,
      },
    ],
    ...overrides,
  }
}

describe('operational usage observer', () => {
  it('records immediately and contains observation failures', async () => {
    vi.useFakeTimers()
    const error = new Error('redis unavailable')
    const inspect = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(snapshot())
    const record = vi.fn().mockResolvedValue({})
    const onError = vi.fn()
    const inspectDeclared = vi.fn().mockResolvedValue({
      observedAt: new Date('2026-08-25T08:00:00Z'),
      scopeCount: 0,
      scopes: [],
      limitations: {
        providerInventoryObserved: false,
        retentionStateObserved: false,
        transferBytesObserved: false,
        dollarCostAssigned: false,
      },
    })
    moduleMocks.recordQueue.mockImplementation(async (_snapshot, passedRecord) => {
      await passedRecord({ metric: 'QUEUE_DEPTH' })
    })
    moduleMocks.recordDeclared.mockResolvedValue({ metricsRecorded: 0 })

    const stop = await startOperationalUsageObserver(onError, {
      inspect: inspect as never,
      inspectDeclared: inspectDeclared as never,
      record,
      intervalMs: 100,
    })
    expect(onError).toHaveBeenCalledWith(error)

    await vi.advanceTimersByTimeAsync(100)
    expect(record).toHaveBeenCalledTimes(1)
    expect(moduleMocks.recordDeclared).toHaveBeenCalledTimes(1)
    expect(moduleMocks.recordQueue).toHaveBeenCalledTimes(1)
    stop()
    vi.useRealTimers()
  })
})
