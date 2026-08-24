import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('support-triage capability migration contract', () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20260824200000_add_support_triage_capability/migration.sql',
    ),
    'utf8',
  )

  it('adds only proposal authority to the fail-closed MCP allowlist', () => {
    expect(migration).toContain("'support:triage'")
    expect(migration).toContain('pathfinder_check_external_credential_evidence')
    expect(migration).not.toContain('DROP TRIGGER')
    expect(migration).not.toContain('UPDATE "support_requests"')
  })
})
