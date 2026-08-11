import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('evaluation run lifecycle migration contract', () => {
  it('is transactional and enforces terminal, attempt, cancellation, and error invariants', async () => {
    const sql = await readFile(
      new URL(
        '../../prisma/migrations/20260811235000_add_evaluation_run_lifecycle/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )
    expect(sql.trimStart()).toMatch(/^BEGIN;/u)
    expect(sql.trimEnd()).toMatch(/COMMIT;$/u)
    expect(sql).toContain('eval_runs_attempt_bounds_check')
    expect(sql).toContain('eval_runs_cancellation_pair_check')
    expect(sql).toContain('eval_runs_terminal_completion_check')
    expect(sql).toContain('eval_runs_error_code_check')
    expect(sql).toContain('eval_runs_lifecycle_transition_guard')
    expect(sql).toContain('DROP TRIGGER "eval_runs_immutable"')
    expect(sql).toContain('eval_runs_no_delete')
    expect(sql).toContain("DEFAULT 'LEGACY'")
    expect(sql).toContain("SET DEFAULT 'STAGED'")
    expect(sql).toContain('invalid evaluation run lifecycle transition')
    expect(sql).toContain('evaluation attempt claim must increment exactly once')
    expect(sql).toContain('evaluation run identity columns cannot change')
    expect(sql).toContain('terminal evaluation run status cannot change')
    expect(sql).toContain('evaluation attempt number cannot decrease')
    expect(sql).toContain('evaluation cancellation evidence cannot change')
  })
})
