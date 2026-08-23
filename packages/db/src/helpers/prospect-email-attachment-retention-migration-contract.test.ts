import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260823090000_add_email_attachment_retention_review/migration.sql',
  ),
  'utf8',
)

describe('prospect email attachment retention migration contract', () => {
  it('stores metadata and review evidence without any byte, object, or provider execution field', () => {
    expect(sql).toContain('prospect_email_attachment_retention_requests')
    expect(sql).toContain('provider_attachment_id')
    expect(sql).toContain('APPROVED_FOR_IMPORT')
    expect(sql).not.toMatch(
      /object_key|storage_key|attachment_body|downloaded_at|provider_executed/iu,
    )
  })

  it('allows at most one active review or approval per exact attachment', () => {
    expect(sql).toContain('prospect_email_attachment_retention_one_active_key')
    expect(sql).toContain("WHERE \"status\" IN ('AWAITING_REVIEW', 'APPROVED_FOR_IMPORT')")
  })

  it('requires terminal review identity and time together', () => {
    expect(sql).toContain('prospect_email_attachment_retention_review_consistency')
    expect(sql).toContain('"review_operation_id" IS NOT NULL')
    expect(sql).toContain('"reviewed_by_id" IS NOT NULL')
    expect(sql).toContain('"reviewed_at" IS NOT NULL')
  })
})
