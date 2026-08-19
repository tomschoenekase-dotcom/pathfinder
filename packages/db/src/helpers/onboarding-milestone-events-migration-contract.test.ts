import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819023000_add_onboarding_milestone_events/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('onboarding milestone events migration', () => {
  it('creates a scoped, replay-safe, bounded-rollup event ledger', () => {
    expect(sql).toContain('CREATE TABLE "onboarding_milestone_events"')
    expect(sql).toContain('"onboarding_milestone_events_replay_key"')
    expect(sql).toContain('"onboarding_milestone_events_timeline_idx"')
    expect(sql).toContain('"onboarding_milestone_events_rollup_idx"')
    expect(sql).toContain('FOREIGN KEY ("venue_id", "tenant_id")')
    expect(sql).toContain('CHECK ("event_version" = 1)')
  })

  it('rejects update, delete, and truncate at the database boundary', () => {
    expect(sql).toContain('BEFORE UPDATE OR DELETE')
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).toContain('onboarding milestone events are append-only')
  })
})
