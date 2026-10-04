import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20261002115000_allow_client_reported_voice_usage/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('client-reported voice usage observation migration', () => {
  it('extends only the existing observation status guard without reclassifying usage', () => {
    const statements = sql
      .replace(/\r\n/gu, '\n')
      .replace(/--[^\n]*/gu, '')
      .split(';')
      .map((statement) => statement.trim())
      .filter(Boolean)
    expect(statements).toEqual([
      'BEGIN',
      'ALTER TABLE "ai_usage_events"\n  DROP CONSTRAINT "ai_usage_events_observation_status_check"',
      'ALTER TABLE "ai_usage_events"\n  ADD CONSTRAINT "ai_usage_events_observation_status_check"\n  CHECK (\n    "usage_observation_status" IS NULL\n    OR "usage_observation_status" IN (\'OBSERVED\', \'UNKNOWN\', \'NOT_DISPATCHED\', \'CLIENT_REPORTED\')\n  )',
      'COMMIT',
    ])
  })
})
