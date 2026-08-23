import { describe, expect, it, vi } from 'vitest'

import { projectOperationsReadiness, readOperationsReadiness } from './operations-readiness'

const persisted = {
  observedAt: new Date('2026-08-23T16:00:00.000Z'),
  migration: { parity: true, expected: 'migration', applied: 'migration' },
  worker: {
    status: 'FRESH',
    fresh: true,
    observedAt: new Date('2026-08-23T16:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-08-23T15:59:30.000Z'),
    ageMs: 30_000,
    freshnessMs: 90_000,
    mode: 'provider-disabled',
    revision: 'revision',
    schedulersEnabled: true,
  },
  queue: { source: 'persisted-job-records', recentWindow: new Date(), byStatus: [] },
  scheduler: { status: 'reported-with-worker-heartbeat' },
  objectStorage: { status: 'not-observed' },
  malwareScanning: null,
  aiProviderOutcomes: [],
  embeddingOutcomes: [],
  emailProviderOutcome: null,
  stuckCriticalJobs: 0,
} as never

const queue = {
  observedAt: new Date('2026-08-23T16:00:00.000Z'),
  coverage: { expectedQueues: 20 as const, observedQueues: 20, complete: true },
  totalDepth: 2,
  totalFailed: 1,
  pausedQueues: 0,
  jobSchedulers: 4,
  oldestAgeMs: 60_000,
  queues: [],
}

describe('operations readiness projection', () => {
  it('requires a complete live queue observation before reporting ready', () => {
    const result = projectOperationsReadiness({
      database: 'up',
      redis: 'up',
      persisted,
      liveQueue: { status: 'observed', value: queue },
    })
    expect(result).toMatchObject({
      schemaVersion: 'pathfinder.operations-readiness.v2',
      status: 'ready',
      queue: {
        live: { status: 'observed', source: 'bullmq-redis', totalDepth: 2 },
        persisted: { source: 'persisted-job-records' },
      },
      boundaries: {
        liveQueueIsPlatformWide: true,
        tenantOrVenueQueueAttributionAvailable: false,
        retryAuthorized: false,
      },
    })
  })

  it('reports a bounded unavailable state without leaking a probe error', async () => {
    const result = await readOperationsReadiness({
      checkDatabase: vi.fn().mockResolvedValue('PONG'),
      checkRedis: vi.fn().mockResolvedValue('PONG'),
      readPersisted: vi.fn().mockResolvedValue(persisted),
      inspectQueue: vi.fn().mockRejectedValue(new Error('PRIVATE_REDIS_ERROR')),
      bypass: vi.fn(async (operation) => operation()),
    })
    expect(result).toMatchObject({
      status: 'degraded',
      queue: { live: { status: 'unavailable', reason: 'probe-failed' } },
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REDIS_ERROR')
  })
})
