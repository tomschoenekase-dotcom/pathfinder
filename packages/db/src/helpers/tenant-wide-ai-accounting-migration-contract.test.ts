import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../../prisma/migrations/20260901020000_support_tenant_wide_ai_accounting/migration.sql',
  import.meta.url,
)
const schemaUrl = new URL('../../prisma/schema.prisma', import.meta.url)

describe('tenant-wide AI accounting migration contract', () => {
  it('makes the three accounting scopes nullable without weakening conversation identity', async () => {
    const [migration, schema] = await Promise.all([
      readFile(migrationUrl, 'utf8'),
      readFile(schemaUrl, 'utf8'),
    ])

    for (const table of ['ai_usage_events', 'ai_usage_daily_rollups', 'ai_cost_reservations']) {
      expect(migration).toContain(`ALTER TABLE "${table}" ALTER COLUMN "venue_id" DROP NOT NULL`)
    }
    expect(migration).toContain('"venue_id" IS NOT NULL')
    expect(migration).toContain('"session_id" IS NULL AND "client_assistant_turn_id" IS NULL')
    expect(migration).toContain('ai_usage_events_tenant_provider_request_key')
    expect(migration).toContain('ai_usage_daily_rollups_tenant_wide_key')
    expect(schema).toMatch(/model AiUsageEvent[\s\S]*?venueId\s+String\?/u)
    expect(schema).toMatch(/model AiUsageDailyRollup[\s\S]*?venueId\s+String\?/u)
    expect(schema).toMatch(/model AiCostReservation[\s\S]*?venueId\s+String\?/u)
  })
})
