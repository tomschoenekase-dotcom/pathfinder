import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260829223000_add_file_clarification_resolutions/migration.sql',
  import.meta.url,
)

describe('intake file clarification resolution migration contract', () => {
  it('binds one immutable resolution to the exact question, receipt, run, venue, and tenant', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('intake_file_resolutions_question_key')
    expect(sql).toContain('intake_file_clarification_resolutions_run_id_tenant_id_venue_id_fkey')
    expect(sql).toContain(
      'intake_file_clarification_resolutions_receipt_id_tenant_id_venue_id_run_id_fkey',
    )
    expect(sql).toContain(
      'intake_file_clarification_resolutions_question_id_tenant_id_venue_id_fkey',
    )
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT')
  })

  it('enforces mutually exclusive replace and exclude evidence shapes', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('intake_file_clarification_resolutions_shape_check')
    expect(sql).toContain('"kind" = \'REPLACE_EXCERPT\'')
    expect(sql).toContain('"kind" = \'EXCLUDE_EVIDENCE\'')
    expect(sql).toContain('length(btrim("amended_excerpt")) > 0')
    expect(sql).toContain('intake_file_extraction_reviews_clarification_resolution_shape_check')
    expect(sql).toContain('"clarification_resolution_count" <= 50')
  })

  it('guards rows and the table against mutation without granting downstream authority', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain("RAISE EXCEPTION '% is append-only'")
    expect(sql).not.toMatch(/approval_grants|provider_dispatch|contact_sent/iu)
  })
})
