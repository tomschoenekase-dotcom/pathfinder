import { readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PLATFORM_TABLES, TENANTED_TABLES } from '../tenanted-tables'

const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const operatorMigration = '20261001090000_add_operator_oauth'
const sql = readFileSync(new URL(`${operatorMigration}/migration.sql`, migrationsRoot), 'utf8')
const operatorModels = [
  'OperatorOAuthClient',
  'OperatorGrant',
  'OperatorAuthorizationCode',
  'OperatorToken',
  'OperatorPlan',
  'OperatorProposal',
  'OperatorAutonomyPolicy',
  'OperatorPolicyState',
  'OperatorAdmissionCounter',
  'OperatorAuditEvent',
] as const

describe('operator OAuth migration contract', () => {
  it('is the single operator migration and sorts after the Release B candidate', () => {
    const names = readdirSync(migrationsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
    expect(names.filter((name) => /operator/u.test(name))).toEqual([operatorMigration])
    expect(names.indexOf(operatorMigration)).toBeGreaterThan(
      names.indexOf('20260930100000_add_mcp_venue_appearance_capabilities'),
    )
  })

  it('is additive only and changes no existing table', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/iu)
    expect(sql).not.toMatch(/\bUPDATE\s+"(?!operator_)/iu)
    for (const match of sql.matchAll(/ALTER TABLE "([a-z_]+)"/gu)) {
      expect(match[1]).toMatch(/^operator_/u)
    }
  })

  it('stores only digests of token material and keeps the audit trail append-only', () => {
    expect(sql).not.toMatch(/"(access|refresh)_token"|"plaintext"|"secret"/u)
    expect(sql).toContain(`CHECK ("code_hash" ~ '^[0-9a-f]{64}$')`)
    expect(sql).toContain(`CHECK ("token_hash" ~ '^[0-9a-f]{64}$')`)
    expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON "operator_audit_events"/u)
    expect(sql).toMatch(/BEFORE TRUNCATE ON "operator_audit_events"/u)
    expect(sql).toContain(`INTERVAL '90 days'`)
  })

  it('registers every operator model as platform-owned, never tenanted', () => {
    for (const model of operatorModels) {
      expect(PLATFORM_TABLES).toContain(model)
      expect(TENANTED_TABLES as readonly string[]).not.toContain(model)
    }
  })
})
