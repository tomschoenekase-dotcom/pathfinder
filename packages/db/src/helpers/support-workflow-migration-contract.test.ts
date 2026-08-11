import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260811180000_add_support_workflow_foundation/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('support workflow migration contract', () => {
  it('creates normalized tenant and venue scoped records', () => {
    for (const table of [
      'support_requests',
      'support_messages',
      'support_message_attachments',
      'support_request_audit_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
      expect(sql).toContain(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_fkey"`)
    }
    expect(sql.match(/REFERENCES "venues"\("id", "tenant_id"\)/gu)).toHaveLength(4)
  })

  it('enforces client-visible client messages and scoped parent relations', () => {
    expect(sql).toContain('"author_kind" <> \'CLIENT\' OR "visibility" = \'CLIENT_VISIBLE\'')
    expect(sql).toContain('FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")')
    expect(sql).toContain(
      'FOREIGN KEY ("support_message_id", "tenant_id", "venue_id", "support_request_id")',
    )
  })

  it('keeps messages, attachments, and audit events append-only', () => {
    for (const table of [
      'support_messages',
      'support_message_attachments',
      'support_request_audit_events',
    ]) {
      expect(sql).toContain(`BEFORE UPDATE OR DELETE ON "${table}"`)
      expect(sql).toContain(`BEFORE TRUNCATE ON "${table}"`)
    }
  })

  it('stores explicit optimistic version and status audit evidence', () => {
    expect(sql).toContain('"version" INTEGER NOT NULL DEFAULT 1')
    expect(sql).toContain('"request_version" INTEGER NOT NULL')
    expect(sql).toContain('"from_status" "SupportRequestStatus"')
    expect(sql).toContain('"to_status" "SupportRequestStatus"')
  })
})
