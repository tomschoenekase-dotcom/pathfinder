import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260824150000_add_internal_support_drafts/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('internal support draft migration contract', () => {
  it('adds one additive lifecycle value without rewriting support data', () => {
    expect(migration).toContain(`ALTER TYPE "SupportRequestStatus" ADD VALUE 'DRAFT' BEFORE 'OPEN'`)
    expect(migration).not.toMatch(/DROP|DELETE|TRUNCATE|UPDATE\s+"support_requests"/u)
  })
})
