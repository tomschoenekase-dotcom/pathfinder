import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260824160000_add_intake_machine_lineage/migration.sql',
  ),
  'utf8',
)

describe('intake machine lineage migration contract', () => {
  it('requires complete agent lineage while preserving human intake rows', () => {
    expect(migration).toContain('"requested_by_type" "ActorType" NOT NULL DEFAULT \'HUMAN\'')
    expect(migration).toContain('"requested_by" = "agent_identity_id"')
    expect(migration).toContain('"approval_grant_id" IS NOT NULL')
    expect(migration).toContain('"capability" = \'intake:draft\'')
    expect(migration).toContain('(("model_provider" IS NULL) = ("model_name" IS NULL))')
    expect(migration).toContain("'intake:draft'")
    expect(migration).toContain('unsupported MCP credential capability')
  })
})
