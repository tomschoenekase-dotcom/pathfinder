import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  join(
    process.cwd(),
    'prisma/migrations/20260907022100_add_ai_usage_observation_status/migration.sql',
  ),
  'utf8',
)

describe('AI usage observation migration contract', () => {
  it('keeps legacy rows unclassified and constrains explicit classifications', () => {
    expect(sql).toContain('ADD COLUMN "usage_observation_status" VARCHAR(32)')
    expect(sql).not.toContain('usage_observation_status" VARCHAR(32) NOT NULL')
    expect(sql).toContain("'OBSERVED', 'UNKNOWN', 'NOT_DISPATCHED'")
  })

  it('adds all four coverage counters with zero-safe historical defaults', () => {
    for (const column of [
      'observed_usage_request_count',
      'unknown_usage_request_count',
      'not_dispatched_request_count',
      'legacy_unclassified_request_count',
    ]) {
      expect(sql).toContain(`"${column}" INTEGER NOT NULL DEFAULT 0`)
    }
    expect(sql).toContain('SET "legacy_unclassified_request_count" = "request_count"')
    expect(sql).toContain('"observed_total_tokens" INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('"observed_estimated_cost_usd" DECIMAL(18,8) NOT NULL DEFAULT 0')
  })
})
