import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260812001200_add_intake_upload_verification_receipts/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('intake upload verification receipt migration', () => {
  it('is forward-only and does not invent legacy scan evidence', () => {
    expect(sql).toContain("ADD VALUE 'PRECHECK_PASSED'")
    expect(sql).toContain('Existing uploads are intentionally not')
    expect(sql).not.toMatch(/INSERT INTO "intake_upload_verification_receipts"\s+SELECT/u)
  })

  it('binds separate precheck and malware receipts to exact immutable object evidence', () => {
    expect(sql).toContain('"kind" "IntakeUploadVerificationKind" NOT NULL')
    expect(sql).toContain('"storage_version_id" VARCHAR(1024) NOT NULL')
    expect(sql).toContain('"object_generation" UUID NOT NULL')
    expect(sql).toContain('"computed_sha256" CHAR(64) NOT NULL')
    expect(sql).toContain('intake upload verification receipt object evidence mismatch')
    expect(sql).toContain('authoritative verification requires passed local precheck evidence')
    expect(sql).toContain('review transition requires exact authoritative receipts')
  })

  it('makes receipts append-only, including truncate', () => {
    expect(sql).toContain('intake upload verification receipt is immutable')
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
  })

  it('allows only pristine RESERVED uploads to be inserted after cutover', () => {
    expect(sql).toContain("IF TG_OP = 'INSERT' THEN")
    expect(sql).toContain('NEW."status" <> \'RESERVED\'')
    expect(sql).toContain('new intake upload must be pristine reserved evidence')
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "intake_uploads"')
  })
})
