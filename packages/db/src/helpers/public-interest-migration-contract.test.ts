import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260825004000_add_public_interest_intake/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const conversionSql = readFileSync(
  new URL(
    '../../prisma/migrations/20260825005000_add_public_interest_prospect_conversion/migration.sql',
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

  it('records reviewed CRM promotion as append-only one-to-one evidence', () => {
    expect(conversionSql).toContain('CREATE TABLE "public_interest_prospect_conversions"')
    expect(conversionSql).toContain('REFERENCES "public_interest_submissions"')
    expect(conversionSql).toContain('REFERENCES "prospect_organizations"')
    expect(conversionSql).toContain('REFERENCES "prospect_venues"')
    expect(conversionSql).toContain('REFERENCES "prospect_contacts"')
    expect(conversionSql).toContain('public interest prospect conversion evidence is append-only')
    expect(conversionSql).toContain(
      'UNIQUE INDEX "public_interest_prospect_conversions_submission_id_key"',
    )
  })
})
