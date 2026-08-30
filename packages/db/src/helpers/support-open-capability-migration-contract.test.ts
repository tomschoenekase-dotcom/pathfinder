import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260824180000_add_support_open_capability/migration.sql',
  ),
  'utf8',
)

describe('support-open capability migration contract', () => {
  it('admits only the new MCP capability without weakening credential evidence', () => {
    expect(migration).toContain("'support:open'")
    expect(migration).toContain('external credential capabilities must be sorted and unique')
    expect(migration).toContain('new external credential requires operation evidence')
    expect(migration).toContain('enabled external credential requires exact activation evidence')
    expect(migration).toContain('unsupported partner credential capability')
  })

  it('does not issue, activate, message, grant participants, or alter support data', () => {
    expect(migration).not.toMatch(/INSERT INTO/iu)
    expect(migration).not.toMatch(/UPDATE\s+"external_credentials"/iu)
    expect(migration).not.toMatch(/support_requests/iu)
    expect(migration).not.toMatch(/support_messages/iu)
    expect(migration).not.toMatch(/support_request_participants/iu)
  })
})
