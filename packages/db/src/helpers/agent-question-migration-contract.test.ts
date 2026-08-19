import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260818173000_add_agent_questions/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('agent question migration contract', () => {
  it('adds a durable input wait state and idempotent question identity', () => {
    expect(sql).toContain('ALTER TYPE "AgentRunStatus" ADD VALUE \'AWAITING_INPUT\'')
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "agent_questions_tenant_operation_key" ON "agent_questions"("tenant_id", "operation_id")',
    )
  })

  it('adds idempotent operator task prompts without mutating legacy runs', () => {
    expect(sql).toContain('ADD COLUMN "operation_id" UUID')
    expect(sql).toContain('ADD COLUMN "request_prompt" VARCHAR(10000)')
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "agent_runs_tenant_operation_key" ON "agent_runs"("tenant_id", "operation_id")',
    )
  })

  it('binds each question to the same tenant, venue, identity, and optional run', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("agent_run_id", "tenant_id", "venue_id") REFERENCES "agent_runs"("id", "tenant_id", "venue_id")',
    )
  })

  it('database-guards question lifecycle and the new run state transitions', () => {
    expect(sql).toContain('pathfinder_guard_agent_question_insert')
    expect(sql).toContain('pathfinder_guard_agent_question_revision')
    expect(sql).toContain('agent question does not match its run identity and scope')
    expect(sql).toContain(
      "OLD.\"status\" = 'AWAITING_INPUT' AND NEW.\"status\" IN ('QUEUED', 'RUNNING', 'FAILED', 'CANCELLED')",
    )
    expect(sql).toContain('CONSTRAINT "agent_questions_answer_state_check"')
  })
})
