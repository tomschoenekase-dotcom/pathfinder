import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260812001400_add_native_venue_deployments/migration.sql',
  ),
  'utf8',
)

describe('native venue deployment migration contract', () => {
  it('is forward-only and keeps generic v2 artifacts separate', () => {
    expect(migration).toContain('No legacy rows are backfilled')
    expect(migration).toContain('native_venue_deployment_artifacts')
    expect(migration).not.toMatch(/UPDATE\s+"venue_package_manifest_artifacts"/iu)
    expect(migration).not.toContain('ON DELETE CASCADE')
  })

  it('guards immutable evidence, exact scoped foreign keys and lifecycle order', () => {
    expect(migration).toContain('native_artifact_immutable')
    expect(migration).toContain('native_effect_immutable')
    expect(migration).toContain('native_command_immutable')
    expect(migration).toContain('invalid native release transition')
    expect(migration).toContain('effect order must be contiguous')
    expect(migration).toContain('native head must match applied release')
    expect(migration).toContain('("artifact_id","tenant_id","venue_id")')
    expect(migration.match(/BEFORE TRUNCATE/gu)).toHaveLength(6)
    expect(migration).toContain("TG_OP='DELETE'")
    expect(migration).toContain('native release must begin pristine DRAFT')
    expect(migration).toContain('NEW.expected_effect_count')
    expect(migration).toContain('NEW.updated_at=NEW.approved_at')
    expect(migration).toContain('NEW.updated_at=NEW.applied_at')
    expect(migration).toContain('NEW.updated_at=NEW.reverted_at')
  })

  it('requires total effect envelopes and immutable replay snapshots', () => {
    expect(migration).toContain('"before_state" ? \'present\'')
    expect(migration).toContain('"after_state" ? \'value\'')
    expect(migration).toContain('"produced_snapshot" JSONB NOT NULL')
    expect(migration).toContain('"kind"=\'REVERT\' AND "produced_status"=\'REVERTED\'')
    expect(migration).toContain("planned->'beforeState' IS DISTINCT FROM NEW.before_state")
    expect(migration).toContain('native command receipt and lifecycle tuple disagree')
    expect(migration).toContain('native command snapshot and scalar evidence disagree')
    expect(migration).toContain('native publication lineage scope disagrees')
    expect(migration).toContain('native publication lineage outcome disagrees')
    expect(migration).toMatch(/expected_action:=CASE[^\n]+END END;/u)
    expect(migration).toMatch(/expected_revision:=CASE[^\n]+END;/u)
    expect(migration).toContain('publication.revision_id IS DISTINCT FROM expected_revision')
    expect(migration).toContain('native publication lineage set is incomplete')
    expect(migration).toContain('native prior head restoration mismatch')
    expect(migration).toContain("prior->>'releaseId'")
    expect(migration).toContain("prior->>'artifactId'")
    expect(migration).toContain("prior->>'manifestHash'")
    expect(migration).toContain("prior->>'stateHash'")
    expect(migration).toContain('native_publication_lineage_publication_fk')
    expect(migration).toContain('p.actor_id IS NOT DISTINCT FROM')
    expect(migration).toContain('SET search_path = pg_catalog, public')
  })
})
