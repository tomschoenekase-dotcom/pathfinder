import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('agent routine database admission contract', () => {
  it('retains database-level bounds when callers bypass the API contract', async () => {
    const migration = await readFile(
      resolve(process.cwd(), 'prisma/migrations/20260918190000_add_agent_routines/migration.sql'),
      'utf8',
    )
    expect(migration).toContain('"interval_seconds" BETWEEN 60 AND 604800')
    expect(migration).toContain('"max_attempts" = 1')
    expect(migration).toContain('"max_runs_per_day" BETWEEN 1 AND 1440')
    expect(migration).toContain('"per_run_budget_e8_usd" >= 0')
    expect(migration).toContain('"daily_budget_e8_usd" >= 0')
    expect(migration).toContain(
      '"daily_budget_e8_usd" IS NULL OR "per_run_budget_e8_usd" IS NOT NULL',
    )
    expect(migration).toContain('"per_run_budget_e8_usd" <= "daily_budget_e8_usd"')
    expect(migration).not.toContain('"last_agent_run_id"')
  })

  it('keeps the budget and stop-rule migration additive with database-level overspend guards', async () => {
    const migration = await readFile(
      resolve(
        process.cwd(),
        'prisma/migrations/20261002112000_add_routine_stop_rules_and_budgets/migration.sql',
      ),
      'utf8',
    )
    // Additive and forward-only: nothing is dropped, renamed or rewritten.
    expect(migration).not.toMatch(/DROP |RENAME |DELETE +FROM|TRUNCATE/iu)
    expect(migration).toContain(`"stop_rules" JSONB NOT NULL DEFAULT '{}'`)
    expect(migration).toContain('"spent_cents" <= "budget_cents"')
    expect(migration).toContain('"spent_cents" >= 0')
    expect(migration).toContain('"estimated_run_cost_cents" BETWEEN 1 AND "budget_cents"')
    expect(migration).toContain('agent_routines_budget_all_or_none_check')
    expect(migration).toContain('("stopped_at" IS NULL) = ("stop_reason" IS NULL)')
    expect(migration).toContain(
      'ON "agent_routine_budget_usage"("routine_id", "period", "period_start")',
    )
  })
})
