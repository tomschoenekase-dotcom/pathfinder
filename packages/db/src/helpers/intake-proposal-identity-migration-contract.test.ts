import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const prior = readFileSync(
  resolve(root, 'prisma/migrations/20260811235960_add_quarantined_intake_upload/migration.sql'),
  'utf8',
)
const migration = readFileSync(
  resolve(
    root,
    'prisma/migrations/20260812000000_allow_proposal_submission_identity/migration.sql',
  ),
  'utf8',
)

describe('intake proposal request identity migration contract', () => {
  it('is forward-only and atomically supersedes the prior source-shape constraint', () => {
    expect(prior).toContain('"source_kind" = \'WEBSITE\'')
    expect(prior).toContain('"submission_request_id" IS NULL')
    expect(migration.trimStart().startsWith('BEGIN;')).toBe(true)
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(migration).toContain('DROP CONSTRAINT "intake_runs_source_shape_check"')
    expect(migration).toContain('ADD CONSTRAINT "intake_runs_source_shape_check" CHECK')
  })

  it('preserves legacy proposals, accepts paired identity, and keeps file uploads identity-free', () => {
    for (const source of ['WEBSITE', 'INTERVIEW']) {
      const branch = migration
        .slice(migration.indexOf(`"source_kind" = '${source}'`))
        .split(/\r?\n/u)[0]
      expect(branch).toContain('"submission_request_id" IS NULL')
      expect(branch).toContain('"submission_input_hash" IS NULL')
      expect(branch).toContain('"submission_request_id" IS NOT NULL')
      expect(branch).toContain('"submission_input_hash" ~ \'^[a-f0-9]{64}$\'')
    }
    const bootstrapBranch = migration.slice(
      migration.indexOf('"source_kind" = \'STRUCTURED_BOOTSTRAP\''),
    )
    expect(bootstrapBranch.slice(0, bootstrapBranch.indexOf(') OR') + 1)).toContain(
      '"submission_request_id" IS NOT NULL',
    )
    expect(bootstrapBranch.slice(0, bootstrapBranch.indexOf(') OR') + 1)).toContain(
      '"submission_input_hash" ~ \'^[a-f0-9]{64}$\'',
    )
    const fileBranch = migration.slice(migration.indexOf('"source_kind" = \'FILE_UPLOAD\''))
    expect(fileBranch).toContain('"submission_request_id" IS NULL')
    expect(fileBranch).toContain('"submission_input_hash" IS NULL')
    expect(migration).not.toMatch(/DROP CONSTRAINT "intake_runs_submission_identity_pair_check"/)
    expect(migration).not.toMatch(/DROP CONSTRAINT "intake_runs_tenant_submission_request_key"/)
  })
})
