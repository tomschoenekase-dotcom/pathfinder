import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825009000_add_founder_operating_exchanges/migration.sql',
  ),
  'utf8',
)

describe('founder operating exchange migration contract', () => {
  it('creates the platform-scoped append-only evidence surface', () => {
    expect(migration).toContain('CREATE TYPE "FounderOperatingIntent"')
    expect(migration).toContain('CREATE TYPE "FounderOperatingDisposition"')
    expect(migration).toContain('CREATE TABLE "founder_operating_exchanges"')
    expect(migration).toContain('founder_operating_exchanges_operation_id_key')
    expect(migration).toContain('founder_operating_exchanges_snapshot_hash_key')
    expect(migration).toContain('founder_operating_exchanges_answer_boundary_check')
    expect(migration).toContain('founder_operating_exchanges_append_only_update_delete')
    expect(migration).toContain('founder_operating_exchanges_append_only_truncate')
  })
})
