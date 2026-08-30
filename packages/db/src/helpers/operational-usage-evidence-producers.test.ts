import { describe, expect, it, vi } from 'vitest'

import {
  recordDeclaredOperationalUsageSnapshot,
  recordQueueOperationalUsageSnapshot,
  type QueueOperationalUsageSnapshot,
} from './operational-usage-evidence-producers'

function queueSnapshot(
  overrides: Partial<QueueOperationalUsageSnapshot> = {},
): QueueOperationalUsageSnapshot {
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
        counts: { waiting: 2, failed: 1 },
        depth: 2,
        failed: 1,
        paused: false,
        jobSchedulers: 1,
        oldestQueuedAt: new Date('2026-08-25T07:59:48.000Z'),
        oldestAgeMs: 12_000,
      },
      {
        name: 'beta',
        counts: { waiting: 1, failed: 0 },
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

describe('operational usage evidence producers', () => {
  it('records three content-addressed queue gauges without monetary fields', async () => {
    const record = vi.fn().mockImplementation(async (input) => ({ id: input.operationId }))

    const result = await recordQueueOperationalUsageSnapshot(queueSnapshot(), record)

    expect(result).toMatchObject({ metricsRecorded: 3, completeQueueCoverage: true })
    expect(record).toHaveBeenCalledTimes(3)
    const inputs = record.mock.calls.map(([input]) => input)
    expect(inputs.map((input) => input.metric)).toEqual([
      'QUEUE_DEPTH',
      'QUEUE_FAILED_JOBS',
      'QUEUE_OLDEST_AGE_MILLISECONDS',
    ])
    expect(new Set(inputs.map((input) => input.sourceDigest)).size).toBe(1)
    expect(new Set(inputs.map((input) => input.operationId)).size).toBe(3)
    for (const input of inputs) {
      expect(input).not.toHaveProperty('amountUsd')
      expect(input).not.toHaveProperty('threshold')
    }
  })

  it('omits oldest age when empty and rejects inconsistent or incomplete coverage', async () => {
    const record = vi.fn().mockResolvedValue({})

    await recordQueueOperationalUsageSnapshot(queueSnapshot({ oldestAgeMs: null }), record)
    expect(record).toHaveBeenCalledTimes(2)

    await expect(
      recordQueueOperationalUsageSnapshot(
        queueSnapshot({ coverage: { expectedQueues: 2, observedQueues: 1, complete: true } }),
        record,
      ),
    ).rejects.toThrow('complete canonical queue coverage')
    await expect(
      recordQueueOperationalUsageSnapshot(
        queueSnapshot({ coverage: { expectedQueues: 2, observedQueues: 1, complete: false } }),
        record,
      ),
    ).rejects.toThrow('complete canonical queue coverage')
  })

  it('records venue-scoped daily declared-byte gauges without provider or cost claims', async () => {
    const record = vi.fn().mockResolvedValue({})

    const result = await recordDeclaredOperationalUsageSnapshot(
      {
        observedAt: new Date('2026-08-25T18:12:00Z'),
        scopeCount: 1,
        scopes: [
          {
            tenantId: 'tenant-1',
            venueId: 'venue-1',
            intakeDeclaredBytes: 12n,
            mediaDeclaredBytes: 30n,
          },
        ],
        limitations: {
          providerInventoryObserved: false,
          retentionStateObserved: false,
          transferBytesObserved: false,
          dollarCostAssigned: false,
        },
      },
      record,
    )

    expect(result).toEqual({
      observedAt: new Date('2026-08-25T00:00:00Z'),
      scopesRecorded: 1,
      metricsRecorded: 2,
      dollarCostAssigned: false,
      providerInventoryObserved: false,
    })
    expect(record.mock.calls.map(([input]) => input.metric)).toEqual([
      'INTAKE_DECLARED_BYTES',
      'MEDIA_DECLARED_BYTES',
    ])
    for (const [input] of record.mock.calls) {
      expect(input).toMatchObject({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        unit: 'BYTES',
        observedAt: new Date('2026-08-25T00:00:00Z'),
      })
      expect(input).not.toHaveProperty('amountUsd')
    }
  })
})
