import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260824140000_add_approval_grant_evidence/migration.sql',
  import.meta.url,
)

describe('approval grant authority evidence migration contract', () => {
  it('adds an append-only, exact-membership table without destructive SQL', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('CREATE TABLE "approval_grant_evidence"')
    expect(sql).toContain('PRIMARY KEY ("approval_grant_id", "outcome_observation_id")')
    expect(sql).toContain('REFERENCES "approval_grants"("id", "tenant_id")')
    expect(sql).toContain('REFERENCES "agent_outcome_observations"("id", "tenant_id")')
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN|TYPE)/iu)
    expect(sql).not.toMatch(/DELETE\s+FROM|TRUNCATE/iu)
  })
})
