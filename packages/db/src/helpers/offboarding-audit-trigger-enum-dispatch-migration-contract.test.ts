import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260823021000_fix_offboarding_audit_trigger_enum_dispatch/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('offboarding audit trigger enum dispatch migration contract', () => {
  it('dispatches the shared trigger by table without cross-binding enum literals', () => {
    expect(sql).toContain("TG_TABLE_NAME = 'offboarding_plans' AND NEW.status::text = 'REVIEWED'")
    expect(sql).toContain(
      "TG_TABLE_NAME = 'offboarding_export_operations' AND NEW.status::text = 'SETTLED'",
    )
    expect(sql).not.toMatch(/NEW\.status\s*=\s*'(?:REVIEWED|SETTLED)'/u)
  })

  it('retains strict review and settlement audit validation', () => {
    expect(sql).toContain('offboarding review audit mismatch')
    expect(sql).toContain('offboarding settlement audit mismatch')
    expect(sql).toContain("audit.action IS DISTINCT FROM 'offboarding-plan.export-reviewed'")
    expect(sql).toContain("audit.action IS DISTINCT FROM 'offboarding-export.artifact-finalized'")
    expect(sql).toContain('SET search_path = pg_catalog, public')
  })
})
