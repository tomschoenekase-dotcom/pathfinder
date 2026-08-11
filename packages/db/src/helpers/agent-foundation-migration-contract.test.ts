import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260811160000_add_agent_native_foundation/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('agent-native foundation migration contract', () => {
  it('keeps access and autonomy independent and fails new identities closed', () => {
    expect(sql).toContain('"access_scope" "AgentAccessScope" NOT NULL')
    expect(sql).toContain('"autonomy_level" "AgentAutonomyLevel" NOT NULL DEFAULT \'READ_ONLY\'')
    expect(sql).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false')
    expect(sql).toContain("('READ_ONLY', 'DRAFT', 'INTERNAL_REVERSIBLE', 'BROAD_AUTONOMOUS')")
  })

  it('binds every optional venue and child record to the same tenant', () => {
    for (const table of [
      'agent_identities',
      'agent_runs',
      'agent_actions',
      'agent_timeline_events',
      'approval_requests',
      'approval_decisions',
    ]) {
      expect(sql).toContain(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_tenant_id_fkey"`)
    }

    expect(
      sql.match(
        /FOREIGN KEY \("venue_id", "tenant_id"\) REFERENCES "venues"\("id", "tenant_id"\)/g,
      ),
    ).toHaveLength(6)
    expect(sql).toContain(
      'FOREIGN KEY ("agent_identity_id", "tenant_id") REFERENCES "agent_identities"("id", "tenant_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("approval_request_id", "tenant_id") REFERENCES "approval_requests"("id", "tenant_id")',
    )
  })

  it('makes actions, timeline events, approval requests, and decisions append-only', () => {
    for (const table of [
      'agent_actions',
      'agent_timeline_events',
      'approval_requests',
      'approval_decisions',
    ]) {
      expect(sql).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"`))
      expect(sql).toMatch(new RegExp(`BEFORE TRUNCATE ON "${table}"`))
    }
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "agent_runs"')
    expect(sql).toContain('BEFORE TRUNCATE ON "agent_runs"')
    expect(sql).toContain('agent run identity and scope are immutable')
  })

  it('uses a single reusable decision record and traces approved execution', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "approval_decisions_approval_request_id_tenant_id_key"',
    )
    expect(sql).toContain('"approval_decision_id" TEXT')
    expect(sql).toContain(
      'FOREIGN KEY ("approval_decision_id", "tenant_id") REFERENCES "approval_decisions"("id", "tenant_id")',
    )
    expect(sql).toContain('AND "decided_by_type" <> \'AGENT\'')
    expect(sql).toContain('AND ("decision" <> \'APPROVED\' OR "decided_by_type" = \'HUMAN\')')
    expect(sql).toContain('expired approval request cannot be approved')
    expect(sql).toContain('approval decision scope does not match its request')
    expect(sql).toContain('agent action does not match its approved scope and operation')
  })

  it('rejects cross-record venue and identity drift inside a tenant', () => {
    expect(sql).toContain('agent run venue exceeds its identity scope')
    expect(sql).toContain('approval request does not match its agent run identity')
    expect(sql).toContain('approval request does not match its agent run venue')
    expect(sql).toContain('agent action does not match its run identity')
    expect(sql).toContain('agent action does not match its run venue')
    expect(sql).toContain('agent action venue exceeds its identity scope')
    expect(sql).toContain('timeline event does not match its action run')
    expect(sql).toContain('timeline event does not match its action venue')
  })
})
