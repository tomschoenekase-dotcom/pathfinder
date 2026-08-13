import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260812001700_add_offboarding_export_finalization/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('offboarding export finalization migration contract', () => {
  it('freezes reservation bytes and exact scope before external dispatch settlement', () => {
    expect(sql).toContain('CREATE TABLE "offboarding_export_operations"')
    expect(sql).toContain('UNIQUE ("tenant_id", "plan_id", "venue_id", "kind")')
    expect(sql).toContain('"canonical_manifest" JSONB NOT NULL')
    expect(sql).toContain('"byte_length" BETWEEN 2 AND 1048576')
    expect(sql).toContain("NEW.status = 'STORED'")
    expect(sql).toContain("NEW.status = 'SETTLED'")
    expect(sql).toContain('offboarding export reservation evidence is immutable')
    expect(sql).toContain('canonical_bytes')
    expect(sql).toContain('offboarding export manifest hash or byte length mismatch')
    expect(sql).toContain('pathfinder_offboarding_manifest_records_valid')
    expect(sql).toContain("ARRAY['classification','id','recordedAt','version']")
    expect(sql).toContain('DIRECT_VENUE_AUDIT_REFERENCE')
    expect(sql).toContain(
      '(APPROVED_CONTENT|CONTENT_HISTORY|VENUE_PACKAGES|CONFIGURATION|AUDIT_HISTORY)\\.json$',
    )
    expect(sql).toContain("'^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$'")
    expect(sql).not.toContain('AUDIT_HISTORY)\\\\.json$')
    expect(sql).not.toContain("'^\\\\d{4}")
  })

  it('binds review and settlement to exact deferred strict audit evidence', () => {
    expect(sql).toContain('export_review_audit_id')
    expect(sql).toContain('settlement_audit_id')
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2)
    expect(sql).toContain("audit.action IS DISTINCT FROM 'offboarding-plan.export-reviewed'")
    expect(sql).toContain("audit.action IS DISTINCT FROM 'offboarding-export.artifact-finalized'")
    expect(sql).toContain('audit.created_at IS DISTINCT FROM NEW.settled_at')
  })

  it('requires a complete declared matrix and blocks unsupported lifecycle advancement', () => {
    expect(sql).toContain("NEW.status = 'EXPORT_READY'")
    expect(sql).toContain('count(*) * cardinality(NEW.export_kinds)')
    expect(sql).toContain('every declared target and kind')
    expect(sql).toContain('unfinished export operations cannot be cancelled')
    expect(sql).toContain('export ready plan cannot advance without separate execution evidence')
    expect(sql).toContain('requested offboarding plan cannot enter an unsupported execution state')
    expect(sql).toContain('cancelled offboarding plan is terminal')
    expect(sql).not.toMatch(/DELETE\s+FROM|UPDATE\s+[^;]*(?:credential|revocation)/iu)
  })

  it('keeps all evidence append-only and hardens functions', () => {
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "offboarding_export_operations"')
    expect(sql).toContain('BEFORE TRUNCATE ON "offboarding_export_operations"')
    expect(sql.match(/SET search_path = pg_catalog, public/gu)?.length).toBeGreaterThanOrEqual(5)
  })
})
