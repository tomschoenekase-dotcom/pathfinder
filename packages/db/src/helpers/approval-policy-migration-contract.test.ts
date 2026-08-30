import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260824130000_add_policy_grant_idempotency/migration.sql',
  import.meta.url,
)

describe('approval policy grant migration contract', () => {
  it('adds nullable legacy-compatible issuance provenance and tenant idempotency', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('ADD COLUMN "operation_id" UUID')
    expect(sql).toContain('ADD COLUMN "issue_reason" VARCHAR(2000)')
    expect(sql).toContain('"approval_grants_tenant_operation_key"')
    expect(sql).toContain('ON "approval_grants"("tenant_id", "operation_id")')
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/iu)
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE/iu)
  })
})
