import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationName = '20260812000100_add_trusted_support_attachments'
const migrationPath = fileURLToPath(
  new URL(`../../prisma/migrations/${migrationName}/migration.sql`, import.meta.url),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('trusted support attachment migration contract', () => {
  it('runs after quarantined upload identity exists and is transaction wrapped', () => {
    expect(migrationName > '20260811235960_add_quarantined_intake_upload').toBe(true)
    expect(sql.trim().startsWith('BEGIN;')).toBe(true)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
  })

  it('adds paired replay identity and a scoped unique operation key', () => {
    expect(sql).toContain('"submission_request_id" UUID')
    expect(sql).toContain('"submission_input_hash" CHAR(64)')
    expect(sql).toContain('support_messages_submission_identity_pair_check')
    expect(sql).toContain('"submission_input_hash" IS NOT NULL')
    expect(sql).toContain("'^[0-9a-f]{64}$'")
    expect(sql).toContain('support_messages_tenant_submission_request_key')
  })

  it('binds each new trusted attachment to one exact scoped intake upload', () => {
    expect(sql).toContain('FOREIGN KEY ("intake_upload_id", "tenant_id", "venue_id")')
    expect(sql).toContain('REFERENCES "intake_uploads"("id", "tenant_id", "venue_id")')
    expect(sql).toContain('support_message_attachments_message_upload_key')
  })

  it('does not rewrite or infer identities for legacy rows', () => {
    expect(sql).not.toMatch(/^\s*UPDATE\s/imu)
    expect(sql).not.toMatch(/^\s*DELETE\s/imu)
    expect(sql).not.toMatch(/^\s*INSERT\s/imu)
  })
})
