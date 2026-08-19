import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260819032000_allow_approved_package_evaluation_snapshot/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('approved package evaluation snapshot migration', () => {
  it('admits only a referenced, positive-version approved package snapshot', () => {
    expect(sql).toContain('DROP CONSTRAINT "eval_runs_content_snapshot_shape_check"')
    expect(sql).toContain('"content_snapshot_kind" = \'APPROVED_VENUE_PACKAGE_V1\'')
    expect(sql).toContain('btrim("content_snapshot_ref") <> \'\'')
    expect(sql).toContain('"content_snapshot_version" > 0')
  })

  it('preserves the legacy and native discriminator branches', () => {
    expect(sql).toContain('"content_snapshot_kind" = \'LEGACY_VENUE_CONTENT_V1\'')
    expect(sql).toContain('"content_snapshot_kind" = \'NATIVE_CORE_V1\'')
  })
})
