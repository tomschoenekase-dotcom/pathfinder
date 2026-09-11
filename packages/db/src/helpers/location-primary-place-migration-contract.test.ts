import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('VenueLocation primary Place migration contract', () => {
  it('uses a nullable scoped foreign key without uniqueness or inferred backfill', () => {
    const migration = readFileSync(
      resolve(
        process.cwd(),
        'prisma/migrations/20260907190000_add_venue_location_primary_place/migration.sql',
      ),
      'utf8',
    )
    expect(migration).toContain('ADD COLUMN "primary_place_id" TEXT')
    expect(migration).toContain('FOREIGN KEY ("primary_place_id", "tenant_id", "venue_id")')
    expect(migration).toContain('REFERENCES "places"("id", "tenant_id", "venue_id")')
    expect(migration).toContain('ON DELETE RESTRICT ON UPDATE RESTRICT')
    expect(migration).not.toMatch(/UNIQUE|UPDATE\s+"venue_locations"/iu)
  })
})
