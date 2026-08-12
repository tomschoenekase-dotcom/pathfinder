import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    'prisma',
    'migrations',
    '20260811235940_add_content_module_publications',
    'migration.sql',
  ),
  'utf8',
)

describe('content module publication migration contract', () => {
  it('is transactional and exact-scope append-only', () => {
    expect(migration.trimStart()).toMatch(/^BEGIN;/)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain('UNIQUE ("tenant_id", "request_id")')
    expect(migration).toContain(
      'FOREIGN KEY ("module_id", "tenant_id", "venue_id") REFERENCES "content_module_identities"',
    )
    expect(migration).toContain(
      'FOREIGN KEY ("revision_id", "tenant_id", "venue_id", "module_id", "module_kind") REFERENCES "content_module_revisions"',
    )
    expect(migration).toContain('"event_order" BIGSERIAL NOT NULL')
    expect(migration).toContain('UNIQUE ("event_order")')
    expect(migration).toContain('UNIQUE ("id", "tenant_id", "venue_id", "module_id", "kind")')
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "content_module_publications"')
    expect(migration).toContain('BEFORE TRUNCATE ON "content_module_publications"')
  })
})
