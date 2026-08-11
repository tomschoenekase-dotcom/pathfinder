import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260809150000_add_evaluation_persistence/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('evaluation persistence migration contract', () => {
  it('enforces append-only update, delete, and truncate boundaries for every evidence table', () => {
    for (const table of ['eval_cases', 'eval_runs', 'eval_results', 'eval_reviews']) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"`))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"`))
    }
  })

  it('pins manifest, prompt, package-pair, JSON-size, and outcome partition invariants', () => {
    expect(sql).toContain('"case_manifest_snapshot" JSONB NOT NULL')
    expect(sql).toContain('OCTET_LENGTH("case_manifest_snapshot"::TEXT) <= 131072')
    expect(sql).toContain('"prompt_contract_hash" ~ \'^[0-9a-f]{64}$\'')
    expect(sql).toContain('"package_snapshot_ref" IS NULL AND "package_snapshot_hash" IS NULL')
    expect(sql).toContain('JSONB_TYPEOF("observation_snapshot") = \'object\'')
    expect(sql).toContain('JSONB_TYPEOF("checks_snapshot") = \'array\'')
    expect(sql).toContain('JSONB_ARRAY_LENGTH("checks_snapshot") = "total_checks"')
    expect(sql).toContain('"outcome" <> \'SCORED\'')
  })

  it('retains composite tenant/venue evidence foreign keys and exact E8 unit comments', () => {
    expect(sql).toContain('FOREIGN KEY ("run_id", "run_identity_hash", "tenant_id", "venue_id")')
    expect(sql).toContain(
      'FOREIGN KEY ("case_id", "case_revision", "case_hash", "tenant_id", "venue_id")',
    )
    expect(sql).toContain('One unit equals 10^-8 USD.')
  })
})
