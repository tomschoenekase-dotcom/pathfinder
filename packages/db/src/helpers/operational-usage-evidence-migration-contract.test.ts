import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825007000_add_operational_usage_evidence/migration.sql',
  ),
  'utf8',
)

const tenantRegistry = readFileSync(resolve(__dirname, '../tenanted-tables.ts'), 'utf8')
const tenantMiddleware = readFileSync(
  resolve(__dirname, '../middleware/tenant-isolation.ts'),
  'utf8',
)

describe('operational usage evidence migration contract', () => {
  it('is additive, typed, scope-safe, content-addressed, and append-only', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('CREATE TABLE "operational_usage_evidence"')
    expect(migration).toContain('operational_usage_evidence_scope_check')
    expect(migration).toContain('operational_usage_evidence_quantity_check')
    expect(migration).toContain('operational_usage_evidence_source_digest_check')
    expect(migration).toContain('operational_usage_evidence_metric_unit_check')
    expect(migration).toContain('operational_usage_evidence_measurement_kind_check')
    expect(migration).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(migration).toContain('operational_usage_evidence_operation_id_key')
    expect(migration).toContain('operational_usage_evidence_append_only_update_delete')
    expect(migration).toContain('operational_usage_evidence_append_only_truncate')
    expect(migration).toContain('pathfinder_reject_append_only_mutation()')
  })

  it('keeps quantity evidence separate from monetary cost and tenant guarded', () => {
    expect(migration).not.toContain('amount_usd')
    expect(tenantRegistry).toContain("'OperationalUsageEvidence'")
    expect(tenantMiddleware).toContain("'OperationalUsageEvidence'")
  })
})
