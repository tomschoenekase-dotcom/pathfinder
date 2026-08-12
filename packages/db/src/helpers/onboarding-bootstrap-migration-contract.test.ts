import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235950_add_onboarding_bootstrap_intake/migration.sql',
  ),
  'utf8',
)

describe('onboarding bootstrap intake migration contract', () => {
  it('adds the enum before its transaction and enforces exact source shape and request identity', () => {
    expect(migration.indexOf("ADD VALUE 'STRUCTURED_BOOTSTRAP'")).toBeLessThan(
      migration.indexOf('BEGIN;'),
    )
    expect(migration).toContain('DROP CONSTRAINT "intake_runs_source_shape_check"')
    expect(migration).toContain('jsonb_typeof("structured_bootstrap") = \'object\'')
    expect(migration).toContain('"submission_input_hash" ~ \'^[a-f0-9]{64}$\'')
    expect(migration).toContain('"intake_runs_submission_identity_pair_check"')
    expect(migration).toContain('UNIQUE ("tenant_id", "submission_request_id")')
  })
})
