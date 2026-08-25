import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825002000_add_guest_answer_attributions/migration.sql',
  ),
  'utf8',
)
const tenantRegistry = readFileSync(resolve(__dirname, '../tenanted-tables.ts'), 'utf8')
const tenantMiddleware = readFileSync(
  resolve(__dirname, '../middleware/tenant-isolation.ts'),
  'utf8',
)

describe('guest answer attribution migration contract', () => {
  it('is additive, exact-scope, append-only, and threshold-free', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('CREATE TABLE "guest_answer_attributions"')
    expect(migration).toContain('guest_answer_attributions_operation_key')
    expect(migration).toContain('guest_answer_attributions_counts_nonnegative_check')
    expect(migration).toContain('guest_answer_attributions_support_rate_check')
    expect(migration).toContain(
      'FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id")',
    )
    expect(migration).toContain('guest_answer_attributions_append_only_update_delete')
    expect(migration).toContain('guest_answer_attributions_append_only_truncate')
    expect(migration).not.toMatch(/minimum|threshold|passed|release/iu)
  })

  it('registers the model in tenant and append-only middleware guardrails', () => {
    expect(tenantRegistry).toContain("'GuestAnswerAttribution'")
    expect(tenantMiddleware).toContain("'GuestAnswerAttribution'")
  })
})
