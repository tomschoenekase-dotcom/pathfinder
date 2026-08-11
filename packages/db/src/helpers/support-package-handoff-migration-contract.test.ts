import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260811220000_add_support_package_handoffs/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('support package handoff migration contract', () => {
  it('uses normalized exact-scope foreign keys and append-only guards', () => {
    expect(sql).toContain('CREATE TABLE "support_package_handoffs"')
    expect(sql).toContain('FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")')
    expect(sql).toContain('FOREIGN KEY ("venue_package_id", "tenant_id", "venue_id")')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).not.toContain('UPDATE "venue_packages"')
  })
})
