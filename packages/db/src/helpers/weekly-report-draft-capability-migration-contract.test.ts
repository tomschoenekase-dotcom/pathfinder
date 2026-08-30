import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260824170000_add_weekly_report_draft_capability/migration.sql',
  ),
  'utf8',
)

describe('weekly-report draft capability migration contract', () => {
  it('admits only the new MCP capability without weakening credential evidence', () => {
    expect(migration).toContain("'reports:draft'")
    expect(migration).toContain('external credential capabilities must be sorted and unique')
    expect(migration).toContain('new external credential requires operation evidence')
    expect(migration).toContain('enabled external credential requires exact activation evidence')
    expect(migration).toContain('unsupported partner credential capability')
  })

  it('does not issue, activate, revoke, publish, or alter report data', () => {
    expect(migration).not.toMatch(/INSERT INTO/iu)
    expect(migration).not.toMatch(/UPDATE\s+"external_credentials"/iu)
    expect(migration).not.toMatch(/weekly_reports/iu)
    expect(migration).not.toMatch(/published_at/iu)
  })
})
