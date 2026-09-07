import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260907021700_add_media_temporal_review_receipts/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('media temporal review receipt migration', () => {
  it('binds compact review evidence to the exact current media generation', () => {
    expect(sql).toContain('octet_length("snapshot"::text) <= 2097152')
    expect(sql).toContain("project_row.status <> 'READY_FOR_REVIEW'")
    expect(sql).toContain("project_row.stage <> 'review'")
    expect(sql).toContain("NEW.snapshot->>'uploadAttemptId'")
    expect(sql).toContain("NEW.snapshot->>'requestId'")
    expect(sql).toContain("NEW.snapshot->>'reviewedBy'")
  })

  it('allows only an exact inactive operational draft and makes both receipts immutable', () => {
    expect(sql).toContain("status='DRAFT' AND is_active=false")
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "media_temporal_review_receipts"')
    expect(sql).toContain('BEFORE TRUNCATE ON "media_temporal_review_receipts"')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "media_temporal_operational_handoffs"')
    expect(sql).toContain('BEFORE TRUNCATE ON "media_temporal_operational_handoffs"')
  })
})
