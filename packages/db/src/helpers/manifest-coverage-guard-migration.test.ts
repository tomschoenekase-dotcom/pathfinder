import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819033000_fix_manifest_coverage_guard/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('manifest coverage guard repair', () => {
  it('counts object keys with supported PostgreSQL primitives', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION pathfinder_guard_venue_package_manifest_artifact',
    )
    expect(sql).toContain('SELECT count(*) FROM jsonb_object_keys')
    expect(sql).not.toMatch(/jsonb_object_length\s*\(/u)
  })

  it('preserves immutable, exact-scope, and shape guards', () => {
    expect(sql).toContain('venue package manifest artifacts are immutable')
    expect(sql).toContain('patch manifest base must be a persisted same-scope FULL artifact')
    expect(sql).toContain(
      "?& ARRAY['IDENTITY','BRANDING','AI_CONFIGURATION','CAPABILITIES','CONTENT','ASSETS','EVALUATION']",
    )
  })
})
