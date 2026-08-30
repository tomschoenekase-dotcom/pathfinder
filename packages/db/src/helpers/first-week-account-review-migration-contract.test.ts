import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825008000_add_first_week_account_reviews/migration.sql',
  ),
  'utf8',
)
const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8')
const tenantRegistry = readFileSync(resolve(__dirname, '../tenanted-tables.ts'), 'utf8')
const tenantMiddleware = readFileSync(
  resolve(__dirname, '../middleware/tenant-isolation.ts'),
  'utf8',
)

describe('first-week account review migration contract', () => {
  it('is additive, scoped to release provenance, and append-only', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('CREATE TABLE "first_week_account_reviews"')
    expect(migration).toContain('first_week_account_reviews_release_event_fkey')
    expect(migration).toContain('first_week_account_reviews_milestone_key')
    expect(migration).toContain('first_week_account_reviews_snapshot_hash_check')
    expect(migration).toContain('first_week_account_reviews_draft_check')
    expect(migration).toContain('first_week_account_reviews_append_only_update_delete')
    expect(migration).toContain('first_week_account_reviews_append_only_truncate')
    expect(migration).toContain('pathfinder_reject_append_only_mutation()')
  })

  it('keeps the model tenant guarded and excludes recipient/provider/send fields', () => {
    expect(tenantRegistry).toContain("'FirstWeekAccountReview'")
    expect(tenantMiddleware).toContain("'FirstWeekAccountReview'")
    const model = schema.match(/model FirstWeekAccountReview \{[\s\S]*?\n\}/u)?.[0] ?? ''
    expect(model).toContain('releaseMilestoneEventId')
    expect(model).not.toMatch(/recipient|provider|sendAt|sentAt/iu)
  })
})
