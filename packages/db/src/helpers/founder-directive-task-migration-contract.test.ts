import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825011000_add_founder_directive_task_handoff/migration.sql',
  ),
  'utf8',
)

describe('founder directive task migration contract', () => {
  it('creates exact scoped proposal, approval, and materialization invariants', () => {
    expect(migration).toContain('CREATE TYPE "FounderDirectiveTaskStatus"')
    expect(migration).toContain('CREATE TABLE "founder_directive_task_requests"')
    expect(migration).toContain('founder_directive_task_requests_materialization_state_check')
    expect(migration).toContain('founder_directive_task_requests_exchange_fkey')
    expect(migration).toContain('founder_directive_task_requests_approval_fkey')
    expect(migration).toContain('founder_directive_task_requests_run_fkey')
    expect(migration).toContain('pathfinder_guard_founder_directive_task_request')
    expect(migration).toContain('invalid founder directive task status transition')
    expect(migration).toContain(
      'materialized founder directive task does not match its exact queued run',
    )
    expect(migration).toContain('founder_directive_task_requests_no_delete')
    expect(migration).toContain('founder_directive_task_requests_no_truncate')
  })
})
