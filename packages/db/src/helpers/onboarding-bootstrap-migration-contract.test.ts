import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const enumMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235945_add_structured_bootstrap_source_kind/migration.sql',
  ),
  'utf8',
)

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235950_add_onboarding_bootstrap_intake/migration.sql',
  ),
  'utf8',
)

describe('onboarding bootstrap intake migration contract', () => {
  it('commits the enum separately before enforcing exact source shape and request identity', () => {
    expect(enumMigration).toContain("ADD VALUE IF NOT EXISTS 'STRUCTURED_BOOTSTRAP'")
    expect(enumMigration).not.toContain('BEGIN;')
    expect(migration).not.toContain("ADD VALUE 'STRUCTURED_BOOTSTRAP'")
    expect(migration).toContain('BEGIN;')
    expect(migration).toContain('DROP CONSTRAINT "intake_runs_source_shape_check"')
    expect(migration).toContain('jsonb_typeof("structured_bootstrap") = \'object\'')
    expect(migration).toContain('"submission_input_hash" ~ \'^[a-f0-9]{64}$\'')
    expect(migration).toContain('"intake_runs_submission_identity_pair_check"')
    expect(migration).toContain('UNIQUE ("tenant_id", "submission_request_id")')
  })
})
