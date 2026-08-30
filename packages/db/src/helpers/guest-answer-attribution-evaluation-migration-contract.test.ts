import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825014000_add_guest_answer_attribution_evaluator_workflow/migration.sql',
  ),
  'utf8',
)
const tenantRegistry = readFileSync(resolve(__dirname, '../tenanted-tables.ts'), 'utf8')

describe('guest answer attribution evaluator workflow migration contract', () => {
  it('is additive, exact-scope, content-addressed, and transaction bounded', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('CREATE TABLE "guest_answer_attribution_evaluation_requests"')
    expect(migration).toContain('guest_answer_attribution_evaluations_hash_check')
    expect(migration).toContain(
      'FOREIGN KEY ("guest_chat_turn_id", "tenant_id", "venue_id", "session_id")',
    )
    expect(migration).toContain('FOREIGN KEY ("result_attribution_id", "tenant_id", "venue_id")')
    expect(migration).toContain('guest_answer_attribution_evaluations_operation_key')
  })

  it('fences dispatch, makes terminal evidence immutable, and forbids deletion', () => {
    expect(migration).toContain('"provider_dispatched_at" TIMESTAMP(3)')
    expect(migration).toContain('provider dispatch evidence is immutable once recorded')
    expect(migration).toContain('terminal guest answer attribution evaluation request is immutable')
    expect(migration).toContain('evaluation requests cannot be deleted')
    expect(migration).toContain(
      "NEW.\"status\" IN ('RUNNING', 'QUEUED', 'COMPLETED', 'FAILED', 'AMBIGUOUS')",
    )
  })

  it('registers tenant isolation without inventing a quality or release decision', () => {
    expect(tenantRegistry).toContain("'GuestAnswerAttributionEvaluationRequest'")
    expect(migration).not.toMatch(/minimum_pass|quality_threshold|release_authorized/iu)
  })
})
