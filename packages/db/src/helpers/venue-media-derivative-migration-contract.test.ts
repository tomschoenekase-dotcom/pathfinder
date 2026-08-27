import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260826020000_add_venue_media_derivatives/migration.sql',
  ),
  'utf8',
)

describe('venue media derivative migration contract', () => {
  it('binds every derivative to the exact tenant, venue, asset, source and approval sequence', () => {
    expect(migration).toContain('"source_object_generation" UUID NOT NULL')
    expect(migration).toContain('"source_storage_version_id" VARCHAR(1024) NOT NULL')
    expect(migration).toContain('"approved_review_sequence" INTEGER NOT NULL')
    expect(migration).toContain('"venue_media_derivatives_asset_scope_fkey"')
    expect(migration).toContain('FOREIGN KEY ("asset_id", "tenant_id", "venue_id")')
  })

  it('permits no partially ready or partially failed delivery row', () => {
    expect(migration).toContain('"venue_media_derivatives_ready_shape_check"')
    expect(migration).toContain('"status" = \'READY\'')
    expect(migration).toContain('"storage_version_id" IS NOT NULL')
    expect(migration).toContain('"mime_type" = \'image/webp\'')
    expect(migration).toContain('"status" = \'PENDING\'')
    expect(migration).toContain('"status" = \'FAILED\'')
    expect(migration).toContain('"failure_code" IS NOT NULL')
  })
})
