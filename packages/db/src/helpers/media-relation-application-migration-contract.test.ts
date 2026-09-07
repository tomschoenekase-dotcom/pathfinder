import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { TENANTED_TABLES } from '../tenanted-tables'

const migration = new URL(
  '../../prisma/migrations/20260907021600_add_media_relation_applications/migration.sql',
  import.meta.url,
)

describe('media relation application migration contract', () => {
  it('adds one exact-scope append-only receipt without canonical activation authority', async () => {
    const sql = await readFile(migration, 'utf8')
    expect(sql).toContain('CREATE TABLE "media_relation_applications"')
    expect(sql).toContain('media_relation_applications_revision_fkey')
    expect(sql).toContain('media_relation_applications_connection_fkey')
    expect(sql).toContain('media_relation_applications_review_key')
    expect(sql).toContain('latest exact resolution revision')
    expect(sql).toContain('only an inactive canonical connection')
    expect(sql).toContain('BEFORE UPDATE OR DELETE ON "media_relation_applications"')
    expect(sql).toContain('BEFORE TRUNCATE ON "media_relation_applications"')
    expect(sql).not.toMatch(/UPDATE\s+"venue_location_connections"|DELETE\s+FROM/iu)
  })

  it('registers the receipt as tenant-scoped and append-only middleware covers it', async () => {
    const middleware = await readFile(
      new URL('../middleware/tenant-isolation.ts', import.meta.url),
      'utf8',
    )
    expect(TENANTED_TABLES).toContain('MediaRelationApplication')
    expect(middleware).toContain("'MediaRelationApplication'")
  })
})
