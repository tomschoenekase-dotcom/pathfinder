import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('staging package commit migration', () => {
  it('persists leases, terminal errors, and every canonical lineage target', () => {
    const migration = readFileSync(
      join(
        process.cwd(),
        'prisma/migrations/20260822113000_add_staging_package_commit_state/migration.sql',
      ),
      'utf8',
    )
    for (const column of [
      'processing_status',
      'claim_token',
      'claim_owner',
      'claim_expires_at',
      'error_code',
      'canonical_organization_id',
      'canonical_venue_id',
      'canonical_contact_id',
      'canonical_evidence_id',
      'canonical_draft_id',
      'processed_at',
    ]) {
      expect(migration).toContain(`"${column}"`)
    }
    expect(migration).toContain('prospect_import_source_records_claim_idx')
  })
})
