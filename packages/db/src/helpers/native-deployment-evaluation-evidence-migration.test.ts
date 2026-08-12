import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260812001500_add_native_deployment_evaluation_evidence/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('native deployment evaluation evidence migration', () => {
  it('preserves required legacy snapshot versions and adds a discriminated exact native shape', () => {
    expect(sql).not.toContain('ALTER COLUMN "content_snapshot_version" DROP NOT NULL')
    expect(sql).toContain("DEFAULT 'LEGACY_VENUE_CONTENT_V1'")
    expect(sql).toContain('"content_snapshot_ref" IS NULL')
    expect(sql).toContain('"content_snapshot_version" > 0')
    expect(sql).toContain("rel.plan->'priorHead'->>'revision'")
    expect(sql).toContain("eval.content_snapshot_kind IS DISTINCT FROM 'NATIVE_CORE_V1'")
    expect(sql).toContain(
      "eval.identity_snapshot->>'version' IS DISTINCT FROM 'pathfinder-eval-run-identity-v3'",
    )
    expect(sql).toContain(
      "eval.identity_snapshot->'runConfigSnapshot' IS DISTINCT FROM eval.run_config_snapshot",
    )
    expect(sql).toContain(
      "eval.identity_snapshot->'caseManifest' IS DISTINCT FROM eval.case_manifest_snapshot",
    )
  })

  it('binds exact release/run/result facts and seals late results', () => {
    expect(sql).toContain('native_deployment_evaluations_release_fkey')
    expect(sql).toContain('native_deployment_evaluations_run_fkey')
    expect(sql).toContain('native deployment evaluation result evidence incomplete')
    expect(sql).toContain("er.outcome = 'SCORED' AND er.passed IS NULL")
    expect(sql).toContain('eval_results_native_evidence_seal_guard')
    expect(sql).toContain('pg_advisory_xact_lock')
    expect(sql).toContain('"actor_type" = \'HUMAN\'')
    expect(sql).toContain('"actor_role" = \'PLATFORM_ADMIN\'')
    expect(sql).toContain('native deployment evaluation operation hash mismatch')
    expect(sql).toContain('pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(')
    expect(sql).not.toContain('public.digest(')
    expect(sql).toContain('native_deployment_evaluations_audit_guard')
    expect(sql).toContain("a.action = 'native_venue_deployment.evaluation-evidence-recorded'")
  })

  it('keeps evidence append-only and never changes native release lifecycle', () => {
    expect(sql).toContain('native_deployment_evaluations_update_delete_guard')
    expect(sql).toContain('native_deployment_evaluations_truncate_guard')
    expect(sql).not.toMatch(/UPDATE\s+"?native_venue_deployment_releases"?/iu)
  })
})
