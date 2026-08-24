import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const enumMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260824230000_add_reviewable_package_evaluation_snapshot/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const constraintMigration = readFileSync(
  new URL(
    '../../prisma/migrations/20260824230100_allow_reviewable_package_evaluation_snapshot/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')

describe('reviewable venue-package evaluation snapshot migration', () => {
  it('commits the new enum discriminator before the constraint uses it', () => {
    expect(enumMigration).toContain(
      `ALTER TYPE "EvalContentSnapshotKind" ADD VALUE IF NOT EXISTS 'REVIEWABLE_VENUE_PACKAGE_V1'`,
    )
    expect(enumMigration).not.toContain('ALTER TABLE "eval_runs"')
    expect(constraintMigration).toContain(`"content_snapshot_kind" = 'REVIEWABLE_VENUE_PACKAGE_V1'`)
    expect(schema).toMatch(/enum EvalContentSnapshotKind[\s\S]*REVIEWABLE_VENUE_PACKAGE_V1/u)
  })

  it('preserves every prior snapshot-shape branch while requiring a positive review version', () => {
    for (const kind of [
      'LEGACY_VENUE_CONTENT_V1',
      'NATIVE_CORE_V1',
      'APPROVED_VENUE_PACKAGE_V1',
      'REVIEWABLE_VENUE_PACKAGE_V1',
    ]) {
      expect(constraintMigration).toContain(`"content_snapshot_kind" = '${kind}'`)
    }
    expect(constraintMigration).toMatch(
      /REVIEWABLE_VENUE_PACKAGE_V1'[\s\S]*"content_snapshot_ref" IS NOT NULL[\s\S]*"content_snapshot_version" > 0/u,
    )
  })
})
