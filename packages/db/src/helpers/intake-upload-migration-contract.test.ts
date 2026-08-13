import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const enumMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235955_add_file_upload_source_kind/migration.sql',
  ),
  'utf8',
)

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235960_add_quarantined_intake_upload/migration.sql',
  ),
  'utf8',
)

describe('quarantined intake upload migration contract', () => {
  it('commits FILE_UPLOAD separately and leaves prior migration immutable', () => {
    expect(enumMigration).toContain("ADD VALUE 'FILE_UPLOAD'")
    expect(enumMigration).not.toContain('BEGIN;')
    expect(migration).not.toContain("ADD VALUE 'FILE_UPLOAD'")
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain('CREATE TABLE "intake_uploads"')
    expect(migration).toContain('DROP CONSTRAINT "intake_runs_source_shape_check"')
    expect(migration).toContain('"source_kind" = \'FILE_UPLOAD\'')
  })

  it('enforces allowlist, 25 MiB ceiling, exact scope FKs, and request uniqueness', () => {
    expect(migration).toContain(
      "'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/tiff'",
    )
    expect(migration).toContain('"byte_size" BETWEEN 1 AND 26214400')
    expect(migration).toContain('UNIQUE INDEX "intake_uploads_tenant_request_key"')
    expect(migration).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("intake_run_id", "tenant_id", "venue_id") REFERENCES "intake_runs"("id", "tenant_id", "venue_id")',
    )
  })

  it('constrains all four status shapes and the exact human role allowlist', () => {
    for (const status of ['RESERVED', 'VERIFYING', 'AWAITING_REVIEW', 'REJECTED']) {
      expect(migration).toContain(`"status" = '${status}'`)
    }
    expect(migration).toContain("'STAFF', 'MANAGER', 'OWNER', 'PLATFORM_ADMIN'")
    expect(migration).toContain('"intake_uploads_claim_pair_check"')
    expect(migration).toContain('"intake_uploads_status_shape_check"')
    expect(migration).toContain('"verification_lease_until" > "verification_claimed_at"')
    expect(migration).toContain('CREATE TRIGGER "intake_uploads_lifecycle_guard"')
    expect(migration).toContain('CREATE TRIGGER "intake_uploads_truncate_guard"')
    expect(migration).toContain("OLD.\"status\" IN ('AWAITING_REVIEW', 'REJECTED')")
    expect(migration).toContain('"storage_version_id"')
  })
})
