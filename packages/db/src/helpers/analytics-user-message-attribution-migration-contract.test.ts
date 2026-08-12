import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812000700_add_analytics_user_message_attribution/migration.sql',
  ),
  'utf8',
)
const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')

describe('analytics user-message attribution migration contract', () => {
  it('adds nullable exact-scope attribution without guessing legacy message identity', () => {
    expect(migration.trimStart()).toMatch(/Legacy events[\s\S]*BEGIN;/u)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('ADD COLUMN "user_message_id" TEXT')
    expect(migration).toContain(
      'FOREIGN KEY ("user_message_id", "tenant_id", "venue_id", "session_id")',
    )
    expect(migration).toContain(
      'REFERENCES "messages"("id", "tenant_id", "venue_id", "session_id")',
    )
    expect(migration).not.toMatch(/UPDATE\s+"analytics_events"/iu)
  })

  it('rejects cross-scope and non-user attribution while retaining structural metadata', () => {
    expect(migration).toContain('analytics_events_user_message_scope_fkey')
    expect(migration).toContain('analytics_events_user_message_guard')
    expect(migration).toContain('message."tenant_id" = NEW."tenant_id"')
    expect(migration).toContain('message."venue_id" = NEW."venue_id"')
    expect(migration).toContain('message."session_id" = NEW."session_id"')
    expect(migration).toContain('message."role" = \'user\'')
    expect(schema).toMatch(
      /userMessage\s+Message\?\s+@relation\("AnalyticsEventUserMessage", fields: \[userMessageId, tenantId, venueId, sessionId\], references: \[id, tenantId, venueId, sessionId\]/u,
    )
  })
})
