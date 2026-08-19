import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819120000_add_tochi_persistence_foundation/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('Tochi persistence migration contract', () => {
  it('is additive and preserves a Classic configuration for every existing venue', () => {
    expect(sql).toContain('CREATE TABLE "venue_bot_configurations"')
    expect(sql).toContain('\'CLASSIC\'::"VenueBotPresentationMode"')
    expect(sql).toContain('FROM "venues" v')
    expect(sql).toContain('ON CONFLICT ("tenant_id", "venue_id") DO NOTHING')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
    expect(sql).not.toContain('ALTER COLUMN "tone_preset"')
  })

  it('preserves all four versioned presets and the conservative legacy mappings', () => {
    for (const preset of ['friendly', 'concise', 'enthusiastic', 'informative']) {
      expect(sql).toContain(`'${preset}'`)
    }
    expect(sql).toContain("WHEN v.\"ai_tone\" = 'PLAYFUL' THEN 'enthusiastic'")
    expect(sql).toContain("WHEN v.\"ai_tone\" = 'PROFESSIONAL' THEN 'informative'")
  })

  it('uses compound tenant and venue foreign keys for every venue-owned record', () => {
    for (const table of [
      'personality_profiles',
      'custom_characters',
      'venue_bot_configurations',
      'client_assistant_threads',
      'client_assistant_turns',
      'client_assistant_support_handoffs',
    ]) {
      const venueForeignKey = sql
        .split('\n')
        .find(
          (line) =>
            line.startsWith(`ALTER TABLE "${table}"`) && line.includes('REFERENCES "venues"'),
        )
      expect(venueForeignKey).toContain(
        'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
      )
    }
  })

  it('binds handoff provenance and usage to an exact assistant turn scope', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("turn_id", "tenant_id", "venue_id") REFERENCES "client_assistant_turns"("id", "tenant_id", "venue_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("client_assistant_turn_id", "tenant_id", "venue_id") REFERENCES "client_assistant_turns"("id", "tenant_id", "venue_id")',
    )
  })

  it('records immutable operation identities and bounded lifecycle constraints', () => {
    expect(sql).toContain('"client_assistant_turns_tenant_id_operation_id_key"')
    expect(sql).toContain('"client_assistant_support_handoffs_tenant_id_operation_id_key"')
    expect(sql).toContain('"client_assistant_turns_hash_format"')
    expect(sql).toContain('"venue_bot_configurations_personality_contract"')
    expect(sql).toContain('"venue_bot_configurations_character_contract"')
  })

  it('persists an exclusive generation lease and stale-claim lookup state', () => {
    expect(sql).toContain('"generation_lease_id" UUID')
    expect(sql).toContain('"generation_lease_expires_at" TIMESTAMP(3)')
    expect(sql).toContain('"generation_attempts" INTEGER NOT NULL DEFAULT 0')
    expect(sql).toContain('"provider_dispatched_at" TIMESTAMP(3)')
    expect(sql).toContain('"client_assistant_turns_generation_lease_id_key"')
    expect(sql).toContain(
      '"client_assistant_turns_tenant_id_status_generation_lease_expires_at_idx"',
    )
    expect(sql).toContain('"generation_attempts" >= 0')
  })
})
