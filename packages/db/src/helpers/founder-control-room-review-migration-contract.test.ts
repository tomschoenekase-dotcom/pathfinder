import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260822120000_add_founder_control_room_reviews/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('founder control room review migration contract', () => {
  it('creates actor-scoped review evidence without tenant or customer authority', () => {
    expect(sql).toContain('CREATE TABLE "founder_control_room_reviews"')
    expect(sql).toContain('"operator_user_id" VARCHAR(191) NOT NULL')
    expect(sql).toContain('"briefing_schema_version" INTEGER NOT NULL')
    expect(sql).not.toMatch(/tenant_id|venue_id|FOREIGN KEY/iu)
  })

  it('enforces monotonic, non-branching, append-only review transitions', () => {
    expect(sql).toContain('"reviewed_through" > "previous_reviewed_through"')
    expect(sql).toContain('"operator_user_id", "previous_reviewed_through") NULLS NOT DISTINCT')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "founder_control_room_reviews"')
    expect(sql).toContain('BEFORE TRUNCATE ON "founder_control_room_reviews"')
    expect(sql.match(/pathfinder_reject_append_only_mutation\(\)/gu)).toHaveLength(2)
  })

  it('binds idempotency and rejects implausibly future client cursors', () => {
    expect(sql).toContain('"founder_control_room_reviews_operation_id_key"')
    expect(sql).toContain('"reviewed_through" <= "created_at" + INTERVAL \'5 minutes\'')
    expect(sql).toContain('"briefing_schema_version" > 0')
  })
})
