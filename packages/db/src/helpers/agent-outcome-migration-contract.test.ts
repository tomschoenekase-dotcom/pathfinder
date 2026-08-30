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
const trustSignalMigration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825010100_structure_agent_operational_trust_signals/migration.sql',
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

  it('requires structurally valid and same-run operational trust signals', () => {
    expect(trustSignalMigration).toContain('agent_outcome_observations_structured_signal_check')
    expect(trustSignalMigration).toContain('agent_outcome_observations_related_action_fkey')
    expect(trustSignalMigration).toContain('agent_outcome_observations_rollback_action_key')
    expect(trustSignalMigration).toContain('agent_outcome_observations_prediction_key')
    expect(trustSignalMigration).toContain(
      'agent outcome action does not match its run identity and scope',
    )
    expect(trustSignalMigration).toContain(
      `NEW."signal_kind" = 'ROLLBACK' AND action_status IS DISTINCT FROM 'SUCCEEDED'`,
    )
  })
})
