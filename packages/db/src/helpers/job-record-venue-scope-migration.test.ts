import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260823120000_add_job_record_venue_scope/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('job record venue-scope migration', () => {
  it('adds, backfills, and indexes additive exact-venue scope', () => {
    expect(sql).toContain('ADD COLUMN "venue_id" TEXT')
    expect(sql).toContain("NULLIF(\"payload\" ->> 'venueId', '')")
    expect(sql).toContain('job_records_tenant_id_venue_id_created_at_idx')
  })

  it('does not destroy job evidence or opaque execution payloads', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/u)
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/u)
    expect(sql).not.toMatch(/SET\s+"payload"/u)
  })
})
