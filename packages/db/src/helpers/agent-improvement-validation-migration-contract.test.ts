import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260824010000_add_agent_improvement_validation_evidence/migration.sql',
  ),
  'utf8',
)

describe('agent improvement validation migration contract', () => {
  it('creates exact scoped immutable validation evidence and never weakens corpus/case identity', () => {
    expect(migration).toContain('CREATE TABLE "agent_improvement_validation_evidence"')
    expect(migration).toContain('"baseline_eval_run_id" UUID NOT NULL')
    expect(migration).toContain('"candidate_eval_run_id" UUID NOT NULL')
    expect(migration).toContain('"implementation_hash" CHAR(64) NOT NULL')
    expect(migration).toContain('"comparison_hash" CHAR(64) NOT NULL')
    expect(migration).toContain('agent_improvement_validations_distinct_runs_check')
    expect(migration).toContain('agent_improvement_validations_tenant_operation_key')
    expect(migration).toContain('agent_improvement_validations_exact_evidence_key')
    expect(migration).toContain('agent_improvement_validations_append_only_guard')
    expect(migration).toContain('agent-improvements:validate')
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ON DELETE CASCADE/u)
  })
})
