import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260824235000_add_support_package_handoff_supersession/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('support package handoff supersession migration', () => {
  it('preserves immutable history and constrains exact scoped replacement lineage', () => {
    expect(migration).toContain('CREATE TABLE "support_package_handoff_supersessions"')
    expect(migration).toContain('support_handoff_supersessions_distinct_handoffs_check')
    expect(migration).toContain('support_handoff_supersessions_prior_scope_key')
    expect(migration).toContain('support_handoff_supersessions_prior_scope_fkey')
    expect(migration).toContain('support_handoff_supersessions_replacement_scope_fkey')
    expect(migration).toContain('support_handoff_supersessions_append_only')
    expect(migration).toContain('support_handoff_supersessions_no_truncate')
    expect(migration).toContain("'packages:reconcile'")
  })
})
