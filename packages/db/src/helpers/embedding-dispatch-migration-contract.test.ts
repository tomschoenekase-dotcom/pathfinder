import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260807223000_add_embedding_dispatch_outbox/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('embedding dispatch outbox migration contract', () => {
  it('authoritatively captures nested Place and Knowledge inserts through database triggers', () => {
    expect(sql).toContain('CREATE TRIGGER places_embedding_dispatch_trigger')
    expect(sql).toContain('CREATE TRIGGER knowledge_embedding_dispatch_trigger')
    expect(sql.match(/AFTER INSERT OR UPDATE OR DELETE ON/gu)).toHaveLength(2)
    expect(sql).toContain("'PLACE'")
    expect(sql).toContain("'KNOWLEDGE_ENTRY'")
  })

  it('upserts one durable dispatch identity instead of requiring direct job enqueue', () => {
    expect(sql).toContain('INSERT INTO embedding_dispatches')
    expect(sql).toContain('ON CONFLICT (tenant_id, venue_id, entity_type, entity_id)')
    expect(sql).toContain('content_updated_at = EXCLUDED.content_updated_at')
  })
})
