import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825001000_add_operating_cost_evidence/migration.sql',
  ),
  'utf8',
)

const tenantRegistry = readFileSync(resolve(__dirname, '../tenanted-tables.ts'), 'utf8')
const tenantMiddleware = readFileSync(
  resolve(__dirname, '../middleware/tenant-isolation.ts'),
  'utf8',
)

describe('operating cost evidence migration contract', () => {
  it('is additive, bounded, scope-safe, and append-only', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('CREATE TABLE "operating_cost_evidence"')
    expect(migration).toContain('operating_cost_evidence_scope_check')
    expect(migration).toContain('operating_cost_evidence_period_check')
    expect(migration).toContain('operating_cost_evidence_amount_check')
    expect(migration).toContain('operating_cost_evidence_quantity_check')
    expect(migration).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(migration).toContain('operating_cost_evidence_operation_id_key')
    expect(migration).toContain('operating_cost_evidence_supersedes_id_key')
    expect(migration).toContain('operating_cost_evidence_append_only_update_delete')
    expect(migration).toContain('operating_cost_evidence_append_only_truncate')
    expect(migration).toContain('pathfinder_reject_append_only_mutation()')
  })

  it('registers the model as shared-scope and append-only in the Prisma guardrails', () => {
    expect(tenantRegistry).toContain("'OperatingCostEvidence'")
    expect(tenantMiddleware).toContain("'OperatingCostEvidence'")
  })
})
