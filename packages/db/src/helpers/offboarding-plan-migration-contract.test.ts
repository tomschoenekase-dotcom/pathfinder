import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260811190000_add_offboarding_plan_foundation/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')
const identityMigrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260811235930_add_offboarding_request_identity/migration.sql',
    import.meta.url,
  ),
)
const identitySql = readFileSync(identityMigrationPath, 'utf8')

describe('offboarding plan migration contract', () => {
  it('creates only planning, target, revocation evidence, and export metadata tables', () => {
    for (const table of [
      'offboarding_plans',
      'offboarding_venue_targets',
      'offboarding_revocation_evidence',
      'offboarding_export_artifacts',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
      expect(sql).toContain(`FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")`)
    }
    expect(sql).not.toMatch(/"delet(?:e|ed|ion)_[a-z_]+"/iu)
  })

  it('binds evidence and exports to an exact plan, tenant, and targeted venue', () => {
    expect(sql.match(/FOREIGN KEY \("plan_id", "tenant_id", "venue_id"\)/gu)).toHaveLength(2)
    expect(
      sql.match(/REFERENCES "offboarding_venue_targets"\("plan_id", "tenant_id", "venue_id"\)/gu),
    ).toHaveLength(2)
    expect(sql).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("plan_id", "tenant_id") REFERENCES "offboarding_plans"("id", "tenant_id")',
    )
  })

  it('makes target scope, revocation evidence, and export metadata append-only', () => {
    for (const table of [
      'offboarding_venue_targets',
      'offboarding_revocation_evidence',
      'offboarding_export_artifacts',
    ]) {
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON "${table}"`)
      expect(sql).toContain(`BEFORE TRUNCATE ON "${table}"`)
    }
    expect(sql).toContain('BEFORE DELETE ON "offboarding_plans"')
    expect(sql).toContain('BEFORE TRUNCATE ON "offboarding_plans"')
  })

  it('does not include execution, revoke, completion, or retention statements', () => {
    expect(sql).not.toMatch(/UPDATE\s+"offboarding_/iu)
    expect(sql).not.toMatch(/DELETE\s+FROM\s+"/iu)
    expect(sql).not.toMatch(/retention|expires_at|purge_at/iu)
  })

  it('adds atomic, exact-tenant immutable request identity without inventing a backfill', () => {
    expect(identitySql.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(identitySql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(identitySql).toContain('ADD COLUMN "request_id" UUID')
    expect(identitySql).toContain('ADD COLUMN "request_hash" CHAR(64)')
    expect(identitySql).toContain('CHECK ("request_hash" ~ \'^[0-9a-f]{64}$\')')
    expect(identitySql).toContain('ON "offboarding_plans"("tenant_id", "request_id")')
    expect(identitySql).toContain('offboarding plan request identity is immutable')
    expect(identitySql).toContain('IF EXISTS (SELECT 1 FROM "offboarding_plans")')
    expect(identitySql).not.toMatch(/UPDATE\s+"offboarding_plans"|DELETE\s+FROM/iu)
  })
})
