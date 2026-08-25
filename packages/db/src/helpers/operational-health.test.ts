import { describe, expect, it, vi } from 'vitest'

import {
  EXPECTED_LATEST_MIGRATION,
  WORKER_HEARTBEAT_FRESHNESS_MS,
  projectWorkerHeartbeat,
  readAppliedMigrationStatus,
} from './operational-health'

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
