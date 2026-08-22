import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260822103000_add_prospect_staging_package_admission/migration.sql',
  ),
  'utf8',
)

describe('prospect staging package migration', () => {
  it('adds immutable package and external-record identity without changing delivery controls', () => {
    expect(sql).toContain('prospect_import_source_records_stable_identity_key')
    expect(sql).toContain('source_workbook_hash')
    expect(sql).toContain('external_record_id')
    expect(sql).not.toMatch(/prospect_send_(?:batches|outbox)/u)
    expect(sql).not.toMatch(/delivery_enabled[^;]*TRUE/iu)
  })
})
