import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('support completion capability migration contract', () => {
  const migration = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20260824220000_add_support_completion_capability/migration.sql',
    ),
    'utf8',
  )

  it('admits only the approval-gated capability through the existing fail-closed trigger', () => {
    expect(migration).toContain("'support:complete'")
    expect(migration).toContain('pathfinder_check_external_credential_evidence')
    expect(migration).not.toContain('DROP TRIGGER')
    expect(migration).not.toContain('INSERT INTO')
    expect(migration).not.toContain('UPDATE ')
    expect(migration).not.toContain('DELETE FROM')
  })
})
