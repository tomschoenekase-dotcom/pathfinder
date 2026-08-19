import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819030000_add_resumable_intake_upload_transport/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)
const lifecycleSql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819031000_harden_resumable_intake_upload_lifecycle/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('resumable intake upload transport migration', () => {
  it('persists a bounded multipart identity and mutually exclusive terminal evidence', () => {
    expect(sql).toContain('"multipart_upload_id" VARCHAR(1024)')
    expect(sql).toContain('"multipart_started_at" TIMESTAMP(3)')
    expect(sql).toContain('"multipart_completed_at" TIMESTAMP(3)')
    expect(sql).toContain('"multipart_aborted_at" TIMESTAMP(3)')
    expect(sql).toContain('"intake_uploads_multipart_lifecycle_check"')
    expect(sql).toContain(
      'NOT ("multipart_completed_at" IS NOT NULL AND "multipart_aborted_at" IS NOT NULL)',
    )
  })

  it('permits only bounded reserved transport changes and exact client cancellation', () => {
    expect(lifecycleSql).toContain('NEW."status" = \'RESERVED\'')
    expect(lifecycleSql).toContain('invalid intake upload transport mutation')
    expect(lifecycleSql).toContain('NEW."rejection_code" IS DISTINCT FROM \'CLIENT_CANCELLED\'')
    expect(lifecycleSql).toContain('"multipart_aborted_at" IS NOT NULL')
    expect(lifecycleSql).toContain('terminal intake upload is immutable')
  })
})
