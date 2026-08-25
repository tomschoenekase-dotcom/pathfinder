import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825180000_add_knowledge_proposal_operational_update_handoff/migration.sql',
  ),
  'utf8',
)

describe('knowledge proposal operational update handoff migration', () => {
  it('is append-only, exactly scoped, and one-to-one at both boundaries', () => {
    expect(migration).toContain('operational_updates_id_scope_key')
    expect(migration).toContain('knowledge_proposal_update_handoffs_proposal_scope_key')
    expect(migration).toContain('knowledge_proposal_update_handoffs_update_scope_key')
    expect(migration).toContain('knowledge_proposal_update_handoffs_proposal_scope_fkey')
    expect(migration).toContain('knowledge_proposal_update_handoffs_update_scope_fkey')
    expect(migration).toContain('knowledge_proposal_update_handoffs_append_only')
    expect(migration).toContain('knowledge_proposal_update_handoffs_no_truncate')
    expect(migration).not.toMatch(/ON DELETE CASCADE/iu)
  })
})
