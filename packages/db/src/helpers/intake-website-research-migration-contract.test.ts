import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migration = new URL(
  '../../prisma/migrations/20260825220000_add_intake_website_research_receipts/migration.sql',
  import.meta.url,
)

describe('website research receipt migration contract', () => {
  it('pins tenant/run/retry scope and makes terminal receipts append-only', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('intake_website_research_receipts_run_scope_fkey')
    expect(sql).toContain('intake_website_research_receipts_prior_scope_fkey')
    expect(sql).toContain('intake_website_research_receipts_terminal_shape_check')
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT')
  })
})
