import { describe, expect, it, vi } from 'vitest'

import { EXPECTED_LATEST_MIGRATION, readAppliedMigrationStatus } from './operational-health'

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
})
