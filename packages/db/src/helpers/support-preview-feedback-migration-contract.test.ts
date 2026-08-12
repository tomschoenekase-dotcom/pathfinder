import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260812000300_add_support_preview_feedback/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('support preview feedback migration contract', () => {
  it('is transactional, exact-scope, client-only, and append-only', () => {
    expect(sql.trim().startsWith('BEGIN;')).toBe(true)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
    expect(sql).toContain('CHECK ("created_by_kind" = \'CLIENT\')')
    expect(sql).toContain(
      'FOREIGN KEY ("support_message_id", "tenant_id", "venue_id", "support_request_id")',
    )
    expect(sql).toContain('FOREIGN KEY ("venue_package_id", "tenant_id", "venue_id")')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).not.toMatch(/UPDATE\s+"(?:venue_packages|support_requests)"/u)
  })
})
