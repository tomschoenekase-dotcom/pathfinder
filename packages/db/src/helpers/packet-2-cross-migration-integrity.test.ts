import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const schema = readFileSync(resolve(root, 'prisma/schema.prisma'), 'utf8')
const registry = readFileSync(resolve(root, 'src/tenanted-tables.ts'), 'utf8')
const middleware = readFileSync(resolve(root, 'src/middleware/tenant-isolation.ts'), 'utf8')
const migrations = {
  intake: readFileSync(
    resolve(root, 'prisma/migrations/20260811210000_add_draft_intake_foundation/migration.sql'),
    'utf8',
  ),
  support: readFileSync(
    resolve(root, 'prisma/migrations/20260811220000_add_support_package_handoffs/migration.sql'),
    'utf8',
  ),
  credentials: readFileSync(
    resolve(root, 'prisma/migrations/20260811230000_add_dark_external_credentials/migration.sql'),
    'utf8',
  ),
  proposalIdentity: readFileSync(
    resolve(
      root,
      'prisma/migrations/20260812000000_allow_proposal_submission_identity/migration.sql',
    ),
    'utf8',
  ),
}

describe('Packet 2 continuation cross-migration integrity', () => {
  it('keeps migration ordering and each migration atomic', () => {
    expect(Object.keys(migrations)).toEqual([
      'intake',
      'support',
      'credentials',
      'proposalIdentity',
    ])
    for (const sql of Object.values(migrations)) {
      expect(sql.trimStart().startsWith('BEGIN;')).toBe(true)
      expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true)
    }
    expect(migrations.intake).toContain('REFERENCES "venue_packages"')
    expect(migrations.support).toContain('REFERENCES "support_requests"')
    expect(migrations.proposalIdentity).toContain(
      'DROP CONSTRAINT "intake_runs_source_shape_check"',
    )
  })

  it('maps every custom intake index name in the final Prisma schema', () => {
    for (const name of [
      'intake_runs_scope_key',
      'intake_runs_scope_kind_key',
      'intake_runs_scope_created_idx',
      'intake_evidence_scope_key',
      'intake_evidence_scope_run_idx',
      'intake_run_events_scope_run_idx',
      'intake_package_handoffs_package_scope_key',
      'intake_package_handoffs_run_scope_key',
      'intake_package_handoffs_scope_created_idx',
    ]) {
      expect(migrations.intake).toContain(`"${name}"`)
      expect(schema).toContain(`map: "${name}"`)
    }
  })

  it('keeps exact-scope foreign keys restrictive across all three foundations', () => {
    for (const sql of Object.values(migrations)) {
      expect(sql).not.toMatch(/ON DELETE (?:CASCADE|SET NULL)|ON UPDATE CASCADE/i)
    }
    expect(migrations.intake).toContain(
      'FOREIGN KEY ("run_id", "tenant_id", "venue_id", "source_kind")',
    )
    expect(migrations.support).toContain(
      'FOREIGN KEY ("support_request_id", "tenant_id", "venue_id")',
    )
    expect(migrations.credentials).toContain(
      'FOREIGN KEY ("previous_credential_id", "tenant_id", "client_id", "scope_key")',
    )
    expect(migrations.proposalIdentity).not.toMatch(/FOREIGN KEY|ON DELETE|ON UPDATE/i)
  })

  it('registers all models and guards only immutable evidence as append-only', () => {
    const models = [
      'IntakeRun',
      'IntakeEvidenceRecord',
      'IntakeRunEvent',
      'IntakePackageHandoff',
      'IntakeUpload',
      'SupportPackageHandoff',
      'SupportPackageHandoffSupersession',
      'ExternalAccessCredential',
      'ExternalCredentialRotation',
      'ExternalCredentialRevocation',
    ]
    for (const model of models) {
      expect(schema).toContain(`model ${model}`)
      expect(registry).toContain(`'${model}'`)
    }
    for (const model of models.filter((name) => name !== 'ExternalAccessCredential')) {
      expect(middleware).toContain(`'${model}'`)
    }
    const appendOnlyBlock = middleware.slice(
      middleware.indexOf('const APPEND_ONLY_MODELS'),
      middleware.indexOf('const AUDIT_LIFECYCLE_MODELS'),
    )
    expect(appendOnlyBlock).not.toContain("'ExternalAccessCredential'")
  })

  it('keeps schema enum and relation identifiers aligned with SQL', () => {
    for (const value of ['WEBSITE', 'INTERVIEW', 'AWAITING_REVIEW', 'PACKAGE_DRAFT_LINKED']) {
      expect(schema).toContain(value)
      expect(migrations.intake).toContain(`'${value}'`)
    }
    for (const value of ['MCP', 'PARTNER_READ_API', 'ARGON2ID']) {
      expect(schema).toContain(value)
      expect(migrations.credentials).toContain(`'${value}'`)
    }
    expect(schema).toContain('@relation("rotation_from"')
    expect(schema).toContain('@relation("rotation_to"')
  })
})
