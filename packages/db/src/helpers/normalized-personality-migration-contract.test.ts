import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819130000_add_normalized_personality_dimensions/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('normalized personality migration contract', () => {
  it('adds the missing bounded dimensions without removing legacy data', () => {
    expect(sql).toContain('ADD COLUMN "brevity" INTEGER NOT NULL DEFAULT 50')
    expect(sql).toContain('ADD COLUMN "energy" INTEGER NOT NULL DEFAULT 50')
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
  })

  it('preserves the relative 1..5 foundation values on the normalized scale', () => {
    expect(sql).toContain('SET "warmth" = ("warmth" - 1) * 25')
    expect(sql).toContain('WHERE "warmth" BETWEEN 1 AND 5')
    expect(sql).toContain('SET "formality" = ("formality" - 1) * 25')
    expect(sql).toContain('WHERE "formality" BETWEEN 1 AND 5')
  })

  it('enforces every client-editable dimension within 0..100', () => {
    expect(sql).toContain('"personality_profiles_normalized_dimensions_check"')
    for (const dimension of ['warmth', 'brevity', 'energy', 'formality']) {
      expect(sql).toContain(`"${dimension}" BETWEEN 0 AND 100`)
    }
  })
})
