import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260907022500_add_intake_v1_processing_dispatches/migration.sql',
  ),
  'utf8',
)

describe('intake V1 processing migration', () => {
  it('binds dispatches to exact immutable members, revisions, runs, and receipts', () => {
    expect(sql).toContain('intake_v1_processing_dispatches_member_scope_fkey')
    expect(sql).toContain('FOREIGN KEY ("member_id", "revision_id", "tenant_id", "venue_id")')
    expect(sql).toContain('intake_v1_processing_dispatches_run_scope_fkey')
    expect(sql).toContain('intake_v1_processing_dispatches_receipt_scope_fkey')
    expect(sql).toContain('member_row.immutable_hash IS DISTINCT FROM NEW.source_hash')
    expect(sql).toContain('receipt_row.run_id IS DISTINCT FROM NEW.intake_run_id')
  })

  it('retains bounded lifecycle and append-only terminal evidence', () => {
    expect(sql).toContain('"attempts" >= 0 AND "attempts" <= 3')
    expect(sql).toContain("OLD.status IN ('COMPLETED', 'HELD', 'FAILED')")
    expect(sql).toContain('intake_v1_processing_dispatches_no_delete')
    expect(sql).toContain('intake_v1_processing_dispatches_no_truncate')
  })
})
