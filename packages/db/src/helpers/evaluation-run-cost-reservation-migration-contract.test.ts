import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235500_add_eval_run_cost_reservations/migration.sql',
  ),
  'utf8',
)

describe('evaluation cost reservation migration contract', () => {
  it('is transactional, additive, bounded, and retains ambiguous evidence', () => {
    expect(sql.trimStart()).toMatch(/^BEGIN;/)
    expect(sql.trimEnd()).toMatch(/COMMIT;$/)
    expect(sql).toContain('budget_accounted_e8_usd')
    expect(sql).toContain('budget_accounted_e8_usd" <= "declared_budget_ceiling_e8_usd')
    expect(sql).toContain('EvalRunCostReservationStatus')
    expect(sql).toContain("'AMBIGUOUS'")
    expect(sql).toContain('eval_run_cost_reservations_scope_key')
    expect(sql).toContain('evaluation cost reservation identity cannot change')
    expect(sql).toContain('evaluation run budget accounting cannot decrease')
    expect(sql).toContain('eval_run_cost_reservations_no_delete')
  })
})
