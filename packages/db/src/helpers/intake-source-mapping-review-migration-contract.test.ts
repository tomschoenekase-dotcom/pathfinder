import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260907022700_add_intake_source_mapping_reviews/migration.sql',
  ),
  'utf8',
)

describe('intake source mapping review migration', () => {
  it('binds both source and derived proposal scope plus exact website receipt lineage', () => {
    expect(migration).toContain('"intake_source_mapping_reviews_source_run_fkey"')
    expect(migration).toContain('"intake_source_mapping_reviews_proposal_run_fkey"')
    expect(migration).toContain('"intake_source_mapping_reviews_research_receipt_fkey"')
    expect(migration).toContain('"research_receipt_id", "tenant_id", "venue_id", "source_run_id"')
  })

  it('is bounded, kind-consistent, and append-only including truncate', () => {
    expect(migration).toContain('"mapping_version" = 1')
    expect(migration).toContain('octet_length("selection_snapshot"::text) <= 50000')
    expect(migration).toContain('octet_length("payload"::text) <= 50000')
    expect(migration).toContain('BEFORE UPDATE OR DELETE OR TRUNCATE')
    expect(migration).toContain('"kind" = \'OPTIONAL_NOTES_SELECTION\'')
  })
})
