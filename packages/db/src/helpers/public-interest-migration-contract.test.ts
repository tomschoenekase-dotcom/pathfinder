import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260825004000_add_public_interest_intake/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('public interest intake migration', () => {
  it('keeps public evidence staged, immutable, and separate from canonical prospects', () => {
    expect(sql).toContain('CREATE TABLE "public_interest_submissions"')
    expect(sql).toContain('CREATE TABLE "public_interest_submission_reviews"')
    expect(sql).toContain('public interest submission evidence is immutable')
    expect(sql).toContain('public interest review history is append-only')
    expect(sql).not.toContain('REFERENCES "prospect_organizations"')
  })
})
