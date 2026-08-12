import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812000800_add_venue_package_manifest_artifacts/migration.sql',
  ),
  'utf8',
)

describe('venue package manifest artifact migration contract', () => {
  it('is forward-only, atomic and invents no legacy manifest identity', () => {
    expect(migration.trimStart()).toMatch(/Historical[\s\S]*BEGIN;/u)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).not.toMatch(/UPDATE\s+"venue_packages"/iu)
    expect(migration).not.toContain('ON DELETE CASCADE')
  })

  it('guards exact scope, discriminator, FULL/PATCH base and immutability', () => {
    expect(migration).toContain('"artifact_kind" = \'VENUE_DEPLOYMENT_MANIFEST_V2\'')
    expect(migration).toContain('"manifest_schema_version" = 2')
    expect(migration).toContain('patch manifest base must be a persisted same-scope FULL artifact')
    expect(migration).toContain('base."tenant_id" = NEW."tenant_id"')
    expect(migration).toContain('base."venue_id" = NEW."venue_id"')
    expect(migration).toContain('venue_packages_manifest_artifact_scope_key')
    expect(migration).toContain('scalar and JSON evidence disagree')
    expect(migration).toContain(
      'jsonb_typeof(NEW."canonical_manifest") IS DISTINCT FROM \'object\'',
    )
    expect(migration).toContain("?& ARRAY['IDENTITY','BRANDING','AI_CONFIGURATION'")
    expect(migration).toMatch(
      /materialization_status" = 'MATERIALIZABLE'[\s\S]*jsonb_typeof\(NEW\."materialization_report" -> 'legacyPayloadHash'\) IS DISTINCT FROM 'string'[\s\S]*legacyPayloadHash' !~ '\^\[a-f0-9\]\{64\}\$'/u,
    )
    expect(migration).toMatch(
      /materialization_status" = 'NOT_MATERIALIZABLE'[\s\S]*legacyPayloadHash' IS DISTINCT FROM 'null'::jsonb/u,
    )
    expect(migration).toContain(
      'artifact."materialization_report" ->> \'legacyPayloadHash\' IS DISTINCT FROM NEW."payload_hash"',
    )
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION pathfinder_guard_venue_package_revision',
    )
    expect(migration).toContain("to_jsonb(NEW) - ARRAY['manifest_artifact_id','updated_at']")
    expect(migration).toContain('exact materializable PATCH DRAFT')
    expect(migration).toContain('legacyPayloadHash')
    expect(migration).toContain('BEFORE UPDATE')
    expect(migration).toContain('BEFORE DELETE')
    expect(migration).toContain('BEFORE TRUNCATE')
  })
})
