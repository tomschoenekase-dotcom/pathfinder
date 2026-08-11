import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235800_add_eval_run_execution_leases/migration.sql',
  ),
  'utf8',
)

describe('evaluation execution lease migration', () => {
  it('pins paired RUNNING lease evidence, expiry recovery, and fenced bounded renewal', () => {
    expect(sql.trimStart()).toMatch(/^BEGIN;/)
    expect(sql.trimEnd()).toMatch(/COMMIT;$/)
    expect(sql).toContain('eval_runs_execution_lease_state_check')
    expect(sql).toContain('eval_runs_expired_execution_lease_idx')
    expect(sql).toContain('active evaluation execution lease cannot be taken over')
    expect(sql).toContain("INTERVAL '15 minutes 1 second'")
    expect(sql).toContain('evaluation lease takeover attempt is invalid')
  })
})
