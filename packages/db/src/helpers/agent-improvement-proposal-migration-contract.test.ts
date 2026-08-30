import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260823233000_add_agent_improvement_proposals/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('agent improvement proposal migration', () => {
  it('keeps proposals review-only, tenant-bound, versioned, and append-only', () => {
    expect(migration).toContain('"agent_improvement_proposals"')
    expect(migration).toContain('"agent_improvement_proposal_evidence"')
    expect(migration).toContain('agent_improvement_proposals_key_revision_key')
    expect(migration).toContain('agent_improvement_proposals_approval_scope_fkey')
    expect(migration).toContain('agent_improvement_evidence_outcome_scope_fkey')
    expect(migration).toContain('agent improvement proposal evidence is append-only')
    expect(migration).toContain("'agent-improvements:propose'")
    expect(migration).toContain("'agent-improvements:read'")
    expect(migration).not.toContain('UPDATE "agent_identities"')
    expect(migration).not.toContain('UPDATE "agent_runs"')
  })
})
