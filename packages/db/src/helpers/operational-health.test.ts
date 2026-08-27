import { describe, expect, it, vi } from 'vitest'

import {
  EXPECTED_LATEST_MIGRATION,
  SERVICE_DEPENDENCY_FRESHNESS_MS,
  WORKER_HEARTBEAT_FRESHNESS_MS,
  projectServiceDependencyObservation,
  projectOperationalPerformance,
  projectWorkerHeartbeat,
  readAppliedMigrationStatus,
} from './operational-health'

describe('operational performance projection', () => {
  const observedAt = new Date('2026-08-27T18:00:00.000Z')
  const windowStartedAt = new Date('2026-08-27T17:00:00.000Z')

  it('projects bounded throughput, retry, latency, and exact estimated cost evidence', () => {
    expect(
      projectOperationalPerformance({
        observedAt,
        windowStartedAt,
        terminalJobs: [
          {
            status: 'COMPLETE',
            startedAt: new Date('2026-08-27T17:10:00.000Z'),
            completedAt: new Date('2026-08-27T17:10:00.100Z'),
            attemptNumber: 1,
          },
          {
            status: 'FAILED',
            startedAt: new Date('2026-08-27T17:20:00.000Z'),
            completedAt: new Date('2026-08-27T17:20:00.500Z'),
            attemptNumber: 3,
          },
        ],
        providerUsage: [
          { latencyMs: 200, attempts: 1, estimatedCostUsd: '0.00000001', success: true },
          { latencyMs: 800, attempts: 2, estimatedCostUsd: '0.12345678', success: false },
        ],
      }),
    ).toMatchObject({
      complete: true,
      windowMs: 3_600_000,
      jobs: {
        terminal: 2,
        completed: 1,
        failed: 1,
        retryAttempts: 2,
        processingMs: { observed: 2, p50: 100, p95: 500 },
      },
      provider: {
        requests: 2,
        successful: 1,
        failed: 1,
        retryAttempts: 1,
        latencyMs: { observed: 2, p50: 200, p95: 800 },
        estimatedCostUsd: '0.12345679',
      },
      boundaries: {
        noPayloads: true,
        noJobIdentity: true,
        noProviderRequestIdentity: true,
        serviceLevelObjectivePolicy: 'UNRESOLVED',
        estimatedCostIsInvoiceTruth: false,
      },
    })
  })

  it('labels capped or empty evidence honestly and ignores invalid durations', () => {
    const result = projectOperationalPerformance({
      observedAt,
      windowStartedAt,
      sampleLimit: 1,
      terminalJobs: [
        {
          status: 'COMPLETE',
          startedAt: observedAt,
          completedAt: windowStartedAt,
          attemptNumber: null,
        },
        {
          status: 'COMPLETE',
          startedAt: windowStartedAt,
          completedAt: observedAt,
          attemptNumber: 1,
        },
      ],
      providerUsage: [],
    })

    expect(result).toMatchObject({
      complete: false,
      jobs: { terminal: 1, processingMs: { observed: 0, p50: null, p95: null } },
      provider: {
        requests: 0,
        latencyMs: { observed: 0, p50: null, p95: null },
        estimatedCostUsd: '0.00000000',
      },
    })
  })
})

describe('operational migration health', () => {
  it('reports exact parity only for the expected latest finished migration', async () => {
    const query = vi.fn().mockResolvedValue([
      {
        migration_name: EXPECTED_LATEST_MIGRATION,
        finished_at: new Date('2026-08-19T12:00:00Z'),
      },
    ])
    await expect(readAppliedMigrationStatus({ $queryRaw: query } as never)).resolves.toMatchObject({
      expected: EXPECTED_LATEST_MIGRATION,
      applied: EXPECTED_LATEST_MIGRATION,
      parity: true,
    })
  })

  it.each([
    '20260825005000_add_public_interest_prospect_conversion',
    '20260825006100_unreviewed_future_migration',
  ])('fails parity for a different terminal migration: %s', async (migrationName) => {
    const query = vi.fn().mockResolvedValue([
      {
        migration_name: migrationName,
        finished_at: new Date('2026-08-25T05:00:00Z'),
      },
    ])

    await expect(readAppliedMigrationStatus({ $queryRaw: query } as never)).resolves.toMatchObject({
      expected: EXPECTED_LATEST_MIGRATION,
      applied: migrationName,
      parity: false,
    })
  })

  it('fails parity when no completed migration is observed', async () => {
    await expect(
      readAppliedMigrationStatus({ $queryRaw: vi.fn().mockResolvedValue([]) } as never),
    ).resolves.toMatchObject({
      expected: EXPECTED_LATEST_MIGRATION,
      applied: null,
      parity: false,
    })
  })
})

describe('worker heartbeat projection', () => {
  const now = new Date('2026-08-23T12:00:00.000Z')

  it('projects fresh provider-dark runtime evidence without operator material', () => {
    expect(
      projectWorkerHeartbeat(
        {
          value: {
            schemaVersion: 1,
            observedAt: '2026-08-23T11:59:30.000Z',
            mode: 'provider-disabled',
            revision: 'revision-1',
            schedulersEnabled: false,
            privateOperator: 'must-not-project',
          },
          updatedAt: new Date('2026-08-23T11:59:31.000Z'),
        },
        now,
      ),
    ).toEqual({
      source: 'persisted-platform-config',
      state: 'FRESH',
      fresh: true,
      staleAfterMs: WORKER_HEARTBEAT_FRESHNESS_MS,
      observedAt: new Date('2026-08-23T11:59:30.000Z'),
      ageMs: 30_000,
      mode: 'provider-disabled',
      revision: 'revision-1',
      schedulersEnabled: false,
      updatedAt: new Date('2026-08-23T11:59:31.000Z'),
    })
  })

  it.each([
    [null, 'NOT_OBSERVED'],
    [
      {
        value: { schemaVersion: 1, observedAt: 'not-a-date', mode: 'provider-enabled' },
        updatedAt: new Date('2026-08-23T11:59:31.000Z'),
      },
      'MALFORMED',
    ],
  ] as const)('fails closed for absent or malformed evidence', (record, state) => {
    expect(projectWorkerHeartbeat(record, now)).toMatchObject({ state, fresh: false })
  })

  it('labels old evidence stale at the shared readiness boundary', () => {
    expect(
      projectWorkerHeartbeat(
        {
          value: {
            schemaVersion: 1,
            observedAt: '2026-08-23T11:58:29.999Z',
            mode: 'provider-enabled',
            revision: 'revision-2',
            schedulersEnabled: true,
          },
          updatedAt: new Date('2026-08-23T11:58:30.000Z'),
        },
        now,
      ),
    ).toMatchObject({ state: 'STALE', fresh: false, ageMs: 90_001 })
  })
})

describe('service dependency observation projection', () => {
  const now = new Date('2026-08-25T06:30:00.000Z')
  const freshRecord = {
    value: {
      schemaVersion: 1,
      observedAt: '2026-08-25T06:29:30.000Z',
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'up',
      privateEndpoint: 'must-not-project',
    },
    updatedAt: new Date('2026-08-25T06:29:31.000Z'),
  }

  it('projects fresh secret-free dependency evidence', () => {
    expect(projectServiceDependencyObservation(freshRecord, now)).toEqual({
      source: 'persisted-platform-config',
      state: 'FRESH',
      fresh: true,
      staleAfterMs: SERVICE_DEPENDENCY_FRESHNESS_MS,
      observedAt: new Date('2026-08-25T06:29:30.000Z'),
      ageMs: 30_000,
      intakeVerificationRequired: true,
      objectStorage: 'up',
      malwareScanner: 'up',
      updatedAt: new Date('2026-08-25T06:29:31.000Z'),
    })
  })

  it('expires old successful observations instead of claiming current connectivity', () => {
    expect(
      projectServiceDependencyObservation(
        {
          ...freshRecord,
          value: { ...freshRecord.value, observedAt: '2026-08-25T06:28:29.999Z' },
        },
        now,
      ),
    ).toMatchObject({ state: 'STALE', fresh: false, ageMs: 90_001 })
  })

  it.each([
    [null, 'NOT_OBSERVED'],
    [
      {
        value: {
          schemaVersion: 1,
          observedAt: '2026-08-25T06:29:30.000Z',
          intakeVerificationRequired: true,
          objectStorage: 'unknown',
          malwareScanner: 'up',
        },
        updatedAt: new Date('2026-08-25T06:29:31.000Z'),
      },
      'MALFORMED',
    ],
  ] as const)('fails closed for absent or malformed dependency evidence', (record, state) => {
    expect(projectServiceDependencyObservation(record, now)).toMatchObject({ state, fresh: false })
  })
})
