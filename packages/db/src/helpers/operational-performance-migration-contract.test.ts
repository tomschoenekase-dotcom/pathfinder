import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { EXPECTED_LATEST_MIGRATION } from './operational-health'

const migrationName = '20260827220000_add_operational_performance_indexes'

describe('operational performance index migration contract', () => {
  it('keeps the bounded platform queries backed by exact additive indexes', async () => {
    const [migration, schema] = await Promise.all([
      readFile(
        new URL(`../../prisma/migrations/${migrationName}/migration.sql`, import.meta.url),
        'utf8',
      ),
      readFile(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8'),
    ])

    expect(EXPECTED_LATEST_MIGRATION).toBe(migrationName)
    expect(migration).toContain('CREATE INDEX "job_records_completed_at_id_idx"')
    expect(migration).toContain('ON "job_records"("completed_at", "id")')
    expect(migration).toContain('CREATE INDEX "ai_usage_events_created_at_id_idx"')
    expect(migration).toContain('ON "ai_usage_events"("created_at", "id")')
    expect(migration).not.toMatch(/DROP|DELETE|TRUNCATE|ALTER\s+COLUMN/iu)
    expect(schema).toContain('@@index([completedAt, id], map: "job_records_completed_at_id_idx")')
    expect(schema).toContain('@@index([createdAt, id], map: "ai_usage_events_created_at_id_idx")')
  })
})
