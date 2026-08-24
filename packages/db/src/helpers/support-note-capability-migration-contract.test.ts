import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('support-note capability migration contract', () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20260824190000_add_support_note_capability/migration.sql',
    ),
    'utf8',
  )

  it('adds only the internal-note capability to the fail-closed MCP allowlist', () => {
    expect(migration).toContain("'support:note'")
    expect(migration).toContain('pathfinder_check_external_credential_evidence')
    expect(migration).not.toContain('DROP TRIGGER')
    expect(migration).not.toContain('customer-visible')
  })
})
