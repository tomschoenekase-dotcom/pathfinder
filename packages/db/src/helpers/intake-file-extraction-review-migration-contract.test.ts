import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260829165000_add_intake_file_extraction_reviews/migration.sql',
  import.meta.url,
)

describe('intake file extraction review migration contract', () => {
  it('binds one terminal review to the exact tenant, venue, source run, and extraction receipt', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('intake_file_extraction_reviews_receipt_key')
    expect(sql).toContain('intake_file_extraction_reviews_receipt_scope_fkey')
    expect(sql).toContain('"receipt_id", "tenant_id", "venue_id", "source_run_id"')
    expect(sql).toContain('intake_file_extraction_reviews_decision_shape_check')
    expect(sql).toContain('ACCEPTED_FOR_PROPOSAL')
    expect(sql).toContain('REJECTED')
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT')
  })

  it('allows accepted reviews to create only one separate proposal run', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('intake_file_extraction_reviews_proposal_key')
    expect(sql).toContain('intake_file_extraction_reviews_distinct_runs_check')
    expect(sql).toContain('intake_file_extraction_reviews_proposal_run_scope_fkey')
    expect(sql).not.toMatch(/venue_packages|approval_grants|provider_dispatch|contact_sent/iu)
  })

  it('makes review decisions append-only through row and truncate guards', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain("RAISE EXCEPTION '% is append-only'")
  })
})
