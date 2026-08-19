import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260818223000_add_agent_outcome_observations/migration.sql',
  ),
  'utf8',
)

describe('agent outcome observation migration contract', () => {
  it('keeps outcome evidence scoped, snapshot-bound, idempotent, and append-only', () => {
    expect(migration).toContain('agent_outcome_observations_tenant_operation_key')
    expect(migration).toContain('agent outcome requires a terminal run')
    expect(migration).toContain('agent outcome execution snapshot does not match its run')
    expect(migration).toContain('agent_outcome_observations_append_only')
    expect(migration).toContain('agent_outcome_observations_no_truncate')
    expect(migration).toContain('pathfinder_reject_append_only_mutation()')
    expect(migration).toContain(
      'FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"',
    )
  })
})
