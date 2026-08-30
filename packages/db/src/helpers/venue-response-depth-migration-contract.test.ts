import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const migrationPath = fileURLToPath(
  new URL(
    '../../prisma/migrations/20260825160000_add_venue_response_depth/migration.sql',
    import.meta.url,
  ),
)
const sql = readFileSync(migrationPath, 'utf8')

describe('venue response-depth migration contract', () => {
  it('adds a constrained response-depth enum and a balanced default', () => {
    expect(sql).toContain('CREATE TYPE "VenueBotResponseDepth"')
    expect(sql).toContain("'BRIEF', 'BALANCED', 'DETAILED'")
    expect(sql).toContain('ADD COLUMN "response_depth" "VenueBotResponseDepth"')
    expect(sql).toContain("DEFAULT 'BALANCED'")
  })

  it('is additive and preserves existing Venue Bot configuration', () => {
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/u)
    expect(sql).not.toMatch(/DELETE\s+FROM/u)
  })
})
