import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

function migration(name: string) {
  return readFileSync(
    fileURLToPath(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url)),
    'utf8',
  )
}

describe('agent runtime migration contracts', () => {
  it('adds bounded leases and retry counters', () => {
    const sql = migration('20260818184500_add_agent_run_execution_leases')
    expect(sql).toContain('"execution_lease_token" UUID')
    expect(sql).toContain('"attempt_number" INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('"max_attempts" INTEGER NOT NULL DEFAULT 3')
  })

  it('binds delegated child runs to the same tenant parent', () => {
    const sql = migration('20260818193000_add_agent_run_delegations')
    expect(sql).toContain('FOREIGN KEY ("parent_agent_run_id", "tenant_id")')
    expect(sql).toContain('REFERENCES "agent_runs"("id", "tenant_id")')
  })

  it('stores bridge presence without secret columns and binds claims to exact tenant sessions', () => {
    const sql = migration('20260818200000_add_agent_bridge_sessions')
    expect(sql).toContain('CREATE TABLE "agent_bridge_sessions"')
    expect(sql).not.toMatch(/secret|browser|subscription_token/iu)
    expect(sql).toContain('FOREIGN KEY ("execution_bridge_session_id", "tenant_id")')
  })

  it('creates an append-only run conversation and hardens retries and bridge ownership', () => {
    const messages = migration('20260818203000_add_agent_messages')
    const guards = migration('20260818204000_harden_agent_runtime_guards')
    expect(messages).toContain('CREATE TABLE "agent_messages"')
    expect(guards).toContain(
      'CREATE FUNCTION pathfinder_reject_append_only_mutation() RETURNS trigger',
    )
    expect(guards.indexOf('CREATE FUNCTION pathfinder_reject_append_only_mutation()')).toBeLessThan(
      guards.indexOf('"agent_messages_append_only"'),
    )
    expect(guards).toContain('"agent_messages_append_only"')
    expect(guards).toContain('OLD."status" = \'RUNNING\' AND NEW."status" IN (\'QUEUED\'')
    expect(guards).toContain('agent run bridge ownership is immutable once claimed')
  })
})
