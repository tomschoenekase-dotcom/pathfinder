import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811234000_add_ai_workload_configuration/migration.sql',
  ),
  'utf8',
)

describe('AI workload configuration migration contract', () => {
  it('is additive, transactional, staged off, and contains no credential field', () => {
    expect(migration).toMatch(/^--[\s\S]*\nBEGIN;/u)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/u)
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
    expect(migration).not.toMatch(/"(?:api_key|credential|secret|access_token)"/iu)
    expect(migration.match(/"enabled" BOOLEAN NOT NULL DEFAULT false/gu)).toHaveLength(2)
    expect(
      migration.match(/"unsafe_changes_enabled" BOOLEAN NOT NULL DEFAULT false/gu),
    ).toHaveLength(2)
  })

  it('enforces exact client/venue scope and tenant-owned composite identities', () => {
    expect(migration).toContain('"scope_level" = \'CLIENT\' AND "venue_id" IS NULL')
    expect(migration).toContain('"scope_level" = \'VENUE\' AND "venue_id" IS NOT NULL')
    expect(migration).toContain('("tenant_id", "venue_scope_key", "workload_id")')
    expect(migration).toContain(
      'FOREIGN KEY ("venue_id", "tenant_id") REFERENCES "venues"("id", "tenant_id")',
    )
  })

  it('keeps independent values consistent and bounded at the database boundary', () => {
    for (const marker of [
      'primary_consistency_check',
      'fallback_enabled_consistency_check',
      'fallback_models_consistency_check',
      'fallback_models_bound_check',
      'timeout_consistency_check',
      'attempts_consistency_check',
      'output_consistency_check',
      'budget_consistency_check',
      'tombstone_check',
      '"timeout_ms" BETWEEN 100 AND 120000',
      '"max_attempts" BETWEEN 1 AND 5',
      '"max_output_tokens" BETWEEN 1 AND 32000',
    ]) {
      expect(migration).toContain(marker)
    }
  })

  it('makes both history tables immutable even to direct SQL update/delete/truncate', () => {
    expect(migration).toContain('prevent_ai_configuration_history_mutation')
    expect(migration.match(/BEFORE UPDATE OR DELETE OR TRUNCATE/gu)).toHaveLength(2)
    expect(migration).toContain('ai_workload_configuration_history_append_only')
    expect(migration).toContain('ai_scoped_workload_configuration_history_append_only')
  })

  it('rejects history inserts whose duplicated scope identity drifts from the parent override', () => {
    expect(migration).toContain('enforce_ai_workload_configuration_history_identity')
    expect(migration).toContain('current_override."workload_id" = NEW."workload_id"')
    expect(migration).toContain('enforce_ai_scoped_configuration_history_identity')
    expect(migration).toContain('current_override."tenant_id" = NEW."tenant_id"')
    expect(migration).toContain('current_override."venue_id" IS NOT DISTINCT FROM NEW."venue_id"')
    expect(migration).toContain('current_override."scope_level" = NEW."scope_level"')
    expect(migration.match(/BEFORE INSERT ON "ai_.*configuration_history"/gu)).toHaveLength(2)
  })
})
