import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812000400_add_durable_guest_chat_turns/migration.sql',
  ),
  'utf8',
)
const schema = readFileSync(resolve(process.cwd(), 'prisma/schema.prisma'), 'utf8')

describe('durable guest chat turn migration contract', () => {
  it('is forward-only, transactional, and preflights legacy scope and pending evidence', () => {
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('legacy message tenant/session scope mismatch')
    expect(migration).toContain('legacy visitor session tenant/venue scope mismatch')
    expect(migration).toContain('legacy analytics event session scope is unresolved')
    expect(migration).toContain(
      'NOT (a."event_type" = \'venue.updated\' AND a."session_id" = \'\')',
    )
    expect(migration).toContain(
      'ALTER TABLE "analytics_events" ALTER COLUMN "session_id" DROP NOT NULL',
    )
    expect(migration).toContain('SET "session_id" = NULL')
    expect(migration).toContain('SET "session_id" = s."id"')
    expect(migration).toContain('analytics_events_session_scope_fkey')
    expect(schema).toMatch(
      /model AnalyticsEvent \{[\s\S]*?sessionId\s+String\?[\s\S]*?session\s+VisitorSession\?\s+@relation\(fields: \[sessionId, tenantId, venueId\]/u,
    )
    expect(migration).toMatch(
      /JOIN "venues" v ON v\."id" = s\."venue_id"[\s\S]*WHERE s\."tenant_id" <> v\."tenant_id"/u,
    )
    expect(migration).toContain('legacy engagement response scope/message mismatch')
    expect(migration).toContain('legacy pending engagement state is invalid')
    expect(migration).toContain('asked."role" <> \'assistant\'')
    expect(migration).toContain('answer."role" <> \'user\'')
    expect(migration).toContain(
      'ROW_NUMBER() OVER (PARTITION BY "session_id" ORDER BY "created_at", "id")',
    )
    expect(migration).not.toMatch(/DELETE FROM|TRUNCATE TABLE|DROP TABLE/iu)
  })

  it('binds exact scope, deterministic sequence, one active turn, and both provider operations', () => {
    expect(migration).toContain('DROP CONSTRAINT "visitor_sessions_venue_id_fkey"')
    expect(migration).toContain(
      'CONSTRAINT "visitor_sessions_venue_scope_fkey" FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id") ON DELETE RESTRICT ON UPDATE CASCADE',
    )
    expect(schema).toMatch(
      /model VisitorSession \{[\s\S]*?venue\s+Venue\s+@relation\(fields: \[venueId, tenantId\], references: \[id, tenantId\], onDelete: Restrict, onUpdate: Cascade\)/u,
    )
    expect(migration).toContain('guest_chat_turns_session_scope_fkey')
    expect(migration).toContain('messages_turn_scope_fkey')
    expect(migration).toContain('engagement_responses_asked_message_scope_fkey')
    expect(migration).toContain('engagement_responses_answer_message_scope_fkey')
    expect(migration).toContain('guest_chat_turns_one_active_per_session_key')
    expect(migration).toContain('messages_session_sequence_key')
    expect(migration).toContain('guest_chat_provider_operations_turn_kind_key')
    expect(migration).toContain("'QUERY_EMBEDDING', 'RESPONSE_GENERATION'")
    expect(migration).toContain("'OBSERVED', 'CANCELLED', 'TERMINAL_AMBIGUOUS'")
  })

  it('enforces valid pending shapes and immutable terminal evidence including truncate', () => {
    expect(migration).toContain('visitor_sessions_pending_shape_check')
    expect(migration).toContain('guest_chat_turn_pending_shape_check')
    expect(migration).toContain('terminal guest chat turn evidence is immutable')
    expect(migration).toContain('terminal guest chat provider operation evidence is immutable')
    expect(migration).toContain('guest_chat_turns_no_truncate')
    expect(migration).toContain('guest_chat_provider_operations_no_truncate')
    expect(migration).toContain('pending engagement asked message must be assistant')
    expect(migration).toContain('guest chat engagement message roles are invalid')
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "engagement_question_responses"',
    )
    expect(migration).toContain('completed guest chat turn evidence is incomplete')
    expect(migration).toContain('failed guest chat turn provider evidence is not terminal')
    expect(migration).toContain('ambiguous guest chat turn provider evidence is not terminal')
    expect(migration).toContain('new guest chat provider operation must be reserved')
    expect(migration).toContain('new guest chat turn must be a pristine reservation')
    expect(migration).toContain('guest chat turn provider reservations are incomplete')
    expect(migration).toMatch(
      /OLD\."status" = 'RESERVED' AND NEW\."status" = 'GENERATING'[\s\S]*kind" = 'QUERY_EMBEDDING'[\s\S]*kind" = 'RESPONSE_GENERATION'/u,
    )
    expect(migration).toContain('BEFORE INSERT OR UPDATE OR DELETE ON "guest_chat_turns"')
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OR DELETE ON "guest_chat_provider_operations"',
    )
    expect(migration).toMatch(
      /status" = 'FAILED'[\s\S]*completed_at" IS NULL[\s\S]*lease_token" IS NULL/u,
    )
    expect(migration).toMatch(
      /status" = 'AMBIGUOUS'[\s\S]*completed_at" IS NULL[\s\S]*lease_token" IS NULL/u,
    )
    expect(migration).toMatch(/status" IN \('RESERVED','GENERATING'\)[\s\S]*failure_code" IS NULL/u)
    expect(migration).toMatch(
      /status" = 'OBSERVED'[\s\S]*lease_token" IS NULL AND "lease_expires_at" IS NULL/u,
    )
    expect(migration).toContain('OLD."user_message_sequence" <> NEW."user_message_sequence"')
    expect(migration).toContain('OLD."pending_asked_at" IS DISTINCT FROM NEW."pending_asked_at"')
    expect(migration).toContain('OLD."created_at" <> NEW."created_at"')
    expect(migration).toMatch(
      /OLD\."created_at" <> NEW\."created_at"[\s\S]*guest chat provider operation identity is immutable/u,
    )
    expect(migration).toMatch(
      /NEW\."status" = 'FAILED'[\s\S]*p\."status" IN \('OBSERVED','CANCELLED'\)/u,
    )
    expect(migration).toMatch(
      /NEW\."status" = 'AMBIGUOUS'[\s\S]*p\."status" IN \('OBSERVED','CANCELLED','TERMINAL_AMBIGUOUS'\)/u,
    )
  })
})
