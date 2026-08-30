import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260823060000_add_multi_venue_price_breakdowns/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('multi-venue price breakdown migration contract', () => {
  it('adds an explicit completeness assertion and venue components without provider side effects', () => {
    expect(migration).toContain('"venue_price_breakdown_complete" BOOLEAN NOT NULL DEFAULT false')
    expect(migration).toContain('"agreed_amount_minor" BIGINT')
    expect(migration).toContain('"commercial_agreement_venues_amount_check"')
    expect(migration).not.toMatch(
      /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?(?:stripe|billing_)/iu,
    )
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
  })

  it('defers exact coverage and sum validation until the commercial transaction commits', () => {
    expect(migration.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2)
    expect(migration).toContain('complete venue price breakdown must price every covered venue')
    expect(migration).toContain('venue price breakdown must equal the agreement total')
    expect(migration).toContain('venue price components require an explicitly complete breakdown')
  })
})
