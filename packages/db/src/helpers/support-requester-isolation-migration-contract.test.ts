import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260812000500_support_requester_isolation/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('support requester isolation migration contract', () => {
  it('is forward-only, transactional, and invents no requester identity', () => {
    expect(sql.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(sql).toContain('SET "requester_user_id" = "created_by_id"')
    expect(sql.indexOf('membership."id" IS NULL')).toBeLessThan(
      sql.indexOf('SET "requester_user_id" = "created_by_id"'),
    )
    expect(sql).not.toMatch(/INSERT\s+INTO\s+"support_requests"/iu)
    expect(sql).toContain('request."created_by_kind" <> \'CLIENT\'')
    expect(sql).toContain('request."created_by_id" <> feedback."created_by_id"')
  })

  it('indexes requester-private pagination and freezes durable ownership', () => {
    expect(sql).toContain('CREATE INDEX "support_requests_requester_activity_idx"')
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "support_requests_requester_updated_idx"')
    for (const column of [
      '"id"',
      '"tenant_id"',
      '"venue_id"',
      '"created_by_kind"',
      '"created_by_id"',
      '"created_at"',
    ]) {
      expect(sql).toContain(`OLD.${column} IS DISTINCT FROM NEW.${column}`)
    }
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "support_requests"')
    expect(sql).toContain('BEFORE TRUNCATE ON "support_requests"')
    expect(sql).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "support_request_participants"')
    expect(sql).toContain('membership."status" = \'ACTIVE\'')
    expect(sql).toContain('only the requester may grant client participant access')
    expect(sql).toContain(
      'CONSTRAINT "support_request_participants_grant_hash_check" CHECK ("grant_operation_hash" ~ \'^[0-9a-f]{64}$\')',
    )
    expect(sql).toContain('only the requester may revoke client participant access')
    expect(sql).toContain('request."requester_user_id" = NEW."revoked_by_id"')
    expect(sql).toContain('ADD COLUMN "client_version" INTEGER')
    expect(sql).toContain('support_messages_client_version_shape_check')
    expect(sql).toContain('ROW_NUMBER() OVER')
    expect(sql).toContain('CREATE UNIQUE INDEX "support_messages_request_client_version_key"')
    expect(sql).toContain('WHERE "client_version" IS NOT NULL')
  })
})
