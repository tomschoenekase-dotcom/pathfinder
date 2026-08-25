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
    mode: 'provider-enabled',
    revision: 'revision',
    schedulersEnabled: true,
  },
  queue: { source: 'persisted-job-records', recentWindow: new Date(), byStatus: [] },
  scheduler: { status: 'reported-with-worker-heartbeat' },
  serviceDependencies: {
    state: 'FRESH',
    fresh: true,
    intakeVerificationRequired: true,
    objectStorage: 'up',
    malwareScanner: 'up',
  },
  objectStorage: { status: 'not-observed' },
  malwareScanning: null,
  aiProviderOutcomes: [],
  embeddingOutcomes: [],
  emailProviderOutcome: null,
  stuckCriticalJobs: 0,
}

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
      persisted: persisted as never,
      liveQueue: { status: 'observed', value: queue },
    })
    expect(result).toMatchObject({
      schemaVersion: 'pathfinder.operations-readiness.v4',
      status: 'ready',
      requirements: {
        databaseConnected: true,
        redisConnected: true,
        migrationParity: true,
        workerHeartbeatFresh: true,
        schedulersEnabled: true,
        providerWorkEnabled: true,
        allQueuesObserved: true,
        noQueuesPaused: true,
        noStuckCriticalJobs: true,
        intakeVerificationEnabled: true,
        objectStorageConnected: true,
        malwareScannerConnected: true,
      },
      queue: {
        live: { status: 'observed', source: 'bullmq-redis', totalDepth: 2 },
        persisted: { source: 'persisted-job-records' },
      },
      boundaries: {
        liveQueueIsPlatformWide: true,
        tenantOrVenueQueueAttributionAvailable: false,
        retryAuthorized: false,
        objectStorageConnectivityProven: true,
        malwareScannerConnectivityProven: true,
      },
    })
  })

  it.each([
    [
      'provider-disabled runtime',
      { worker: { ...persisted.worker, mode: 'provider-disabled' } },
      queue,
    ],
    ['disabled schedulers', { worker: { ...persisted.worker, schedulersEnabled: false } }, queue],
    ['paused queues', {}, { ...queue, pausedQueues: 1 }],
    ['stuck critical work', { stuckCriticalJobs: 1 }, queue],
    [
      'stale service dependencies',
      { serviceDependencies: { ...persisted.serviceDependencies, fresh: false, state: 'STALE' } },
      queue,
    ],
    [
      'disabled intake verification',
      {
        serviceDependencies: {
          ...persisted.serviceDependencies,
          intakeVerificationRequired: false,
        },
      },
      queue,
    ],
    [
      'unavailable object storage',
      { serviceDependencies: { ...persisted.serviceDependencies, objectStorage: 'down' } },
      queue,
    ],
    [
      'unavailable malware scanner',
      { serviceDependencies: { ...persisted.serviceDependencies, malwareScanner: 'down' } },
      queue,
    ],
  ] as const)('does not report ready with %s', (_case, persistedOverride, queueOverride) => {
    const result = projectOperationsReadiness({
      database: 'up',
      redis: 'up',
      persisted: { ...persisted, ...persistedOverride } as never,
      liveQueue: { status: 'observed', value: queueOverride },
    })

    expect(result.status).toBe('degraded')
    expect(Object.values(result.requirements)).toContain(false)
  })

  it('reports a bounded unavailable state without leaking a probe error', async () => {
    const result = await readOperationsReadiness({
      checkDatabase: vi.fn().mockResolvedValue('PONG'),
      checkRedis: vi.fn().mockResolvedValue('PONG'),
      readPersisted: vi.fn().mockResolvedValue(persisted as never),
      inspectQueue: vi.fn().mockRejectedValue(new Error('PRIVATE_REDIS_ERROR')),
    })
    expect(result).toMatchObject({
      status: 'degraded',
      queue: { live: { status: 'unavailable', reason: 'probe-failed' } },
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_REDIS_ERROR')
  })
})
