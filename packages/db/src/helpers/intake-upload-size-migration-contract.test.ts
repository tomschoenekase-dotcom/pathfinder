import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819013000_bound_non_media_intake_uploads/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('intake upload transport size migration', () => {
  it('keeps large media support while bounding fully parsed non-media files', () => {
    expect(sql).toContain('"byte_size" BETWEEN 1 AND 2000000000')
    expect(sql).toContain('"byte_size" BETWEEN 1 AND 104857600')
    expect(sql).toContain('video/mp4')
    expect(sql).toContain('audio/webm')
    expect(sql).toContain('intake_uploads_transport_size_check')
  })
})
