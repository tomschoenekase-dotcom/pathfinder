import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

describe('Support AgentRun lineage migration', () => {
  it('is atomic, forward-only, immutable and exact-scoped without backfill', async () => {
    const sql = await readFile(
      new URL(
        '../../prisma/migrations/20260812001000_add_support_agent_run_lineage/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )
    expect(sql.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/)
    expect(sql).toContain('CREATE TABLE "support_agent_run_lineages"')
    expect(sql).toContain('support_agent_run_lineages_request_event_fkey')
    expect(sql).toContain('support_agent_run_lineages_run_scope_fkey')
    expect(sql).toContain('support_agent_run_lineages_run_scope_key')
    expect(sql).toContain('support_agent_run_lineages_append_only')
    expect(sql).toContain('support_agent_run_lineages_insert_guard')
    expect(sql).toContain('NEW."linked_run_status" IS DISTINCT FROM run_status')
    expect(sql).toContain('support_agent_run_lineages_no_truncate')
    expect(sql).not.toMatch(/INSERT INTO\s+"support_agent_run_lineages"/i)
    expect(sql).not.toMatch(/UPDATE\s+"support_agent_run_lineages"/i)
  })

  it('aborts historical mismatches and installs NULL-safe exact approval/action guards', async () => {
    const sql = await readFile(
      new URL(
        '../../prisma/migrations/20260812001000_add_support_agent_run_lineage/migration.sql',
        import.meta.url,
      ),
      'utf8',
    )
    expect(sql).toContain('request."venue_id" IS DISTINCT FROM run."venue_id"')
    expect(sql).toContain('request."agent_identity_id" IS DISTINCT FROM run."agent_identity_id"')
    expect(sql).toContain('action."venue_id" IS DISTINCT FROM run."venue_id"')
    expect(sql).toContain('action."requested_operation" IS DISTINCT FROM run."requested_operation"')
    expect(sql).toContain('request."agent_run_id" IS DISTINCT FROM action."agent_run_id"')
    expect(sql).toContain('request."proposed_action" IS DISTINCT FROM action."action_name"')
    expect(sql).toContain('decision."decision" IS DISTINCT FROM \'APPROVED\'')
    expect(sql).toContain('request_run_id IS NULL')
    expect(sql).toContain("recorded_decision <> 'APPROVED'")
    expect(sql).toContain('NEW."requested_operation" IS DISTINCT FROM run_requested_operation')
  })
})
