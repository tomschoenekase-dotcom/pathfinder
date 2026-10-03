import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20261002113000_add_offboarding_execution/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
).replaceAll('\r\n', '\n')

describe('offboarding execution migration contract', () => {
  it('is additive: two tenant-scoped tables, no change to an existing table or row', () => {
    expect(sql.match(/CREATE TABLE "/gu)).toHaveLength(2)
    expect(sql).not.toMatch(/\bDROP\b/u)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/iu)
    expect(sql).not.toMatch(/\bUPDATE\s+"/iu)
    expect(sql).not.toMatch(/\bTRUNCATE\s+(?:TABLE\s+)?"/iu)
    // Only the two new tables are altered, to attach their own foreign keys.
    expect(sql.match(/ALTER TABLE "([a-z_]+)"/gu)).toEqual([
      'ALTER TABLE "offboarding_executions"',
      'ALTER TABLE "offboarding_execution_steps"',
    ])
  })

  it('never cascades: every foreign key restricts', () => {
    expect(sql).not.toMatch(/ON DELETE (?:CASCADE|SET NULL|SET DEFAULT)/u)
    expect(sql).not.toMatch(/ON UPDATE (?:CASCADE|SET NULL|SET DEFAULT)/u)
    expect(sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/gu)).toHaveLength(4)
  })

  it('binds each row to its tenant and the execution to an exact plan of that tenant', () => {
    expect(sql).toContain('FOREIGN KEY ("tenant_id")')
    expect(sql).toContain(
      'FOREIGN KEY ("plan_id", "tenant_id")\n    REFERENCES "offboarding_plans"("id", "tenant_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("execution_id", "tenant_id")\n    REFERENCES "offboarding_executions"("id", "tenant_id")',
    )
  })

  it('allows one execution per plan and one row per step', () => {
    expect(sql).toContain('CREATE UNIQUE INDEX "offboarding_executions_plan_key"')
    expect(sql).toContain('CREATE UNIQUE INDEX "offboarding_execution_steps_key"')
  })

  it('keeps execution history: no row of either table can be deleted or truncated', () => {
    for (const table of ['offboarding_executions', 'offboarding_execution_steps']) {
      expect(sql).toContain(`BEFORE DELETE ON "${table}"`)
      expect(sql).toContain(`BEFORE TRUNCATE ON "${table}"`)
    }
  })

  it('does not touch the plan: it never advances the reviewed status', () => {
    expect(sql).not.toContain('offboarding_plans" SET')
    expect(sql).not.toMatch(/ALTER TABLE "offboarding_plans"/u)
  })
})
