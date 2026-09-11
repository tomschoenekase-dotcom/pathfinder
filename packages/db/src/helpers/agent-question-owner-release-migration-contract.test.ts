import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('answered agent question execution-owner release migration', () => {
  it('allows only the exact answered-blocker owner clear while retaining prior fences', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20260908031000_release_answered_agent_execution_owner/migration.sql',
      ),
      'utf8',
    )
    expect(sql).toContain('OLD."status" = \'AWAITING_INPUT\' AND NEW."status" = \'QUEUED\'')
    expect(sql).toContain('NEW."execution_bridge_session_id" IS NULL')
    expect(sql).toContain('NEW."execution_worker_id" IS NULL')
    expect(sql).toContain('NEW."execution_lease_token" IS NULL')
    expect(sql).toContain('NEW."execution_lease_expires_at" IS NULL')
    expect(sql).toContain('NEW."last_heartbeat_at" IS NULL')
    expect(sql).toContain('NEW."attempt_number" = OLD."attempt_number"')
    expect(sql).toContain(') IS NOT TRUE THEN')
    expect(sql).toContain('OLD."execution_lease_expires_at" < CURRENT_TIMESTAMP')
    expect(sql).toContain('agent run identity and scope are immutable')
    expect(sql).toContain('agent run attempts must advance exactly once at claim')
  })
})
