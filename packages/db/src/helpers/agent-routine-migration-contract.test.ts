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
})
