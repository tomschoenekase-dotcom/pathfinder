import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const retentionMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260822063000_add_google_source_retention_foundation/migration.sql',
  ),
  'utf8',
)
const sourceMigration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260822064500_add_calendar_meet_source_models/migration.sql',
  ),
  'utf8',
)

describe('Google Workspace source migration contracts', () => {
  it('preserves legacy Gmail bodies and creates no deletion executor', () => {
    expect(retentionMigration).toContain("'LEGACY_REVIEW_REQUIRED'")
    expect(retentionMigration).not.toMatch(
      /UPDATE[\s\S]+SET[\s\S]+"(?:text|html)_body"\s*=\s*NULL/iu,
    )
    expect(retentionMigration).not.toMatch(/DELETE\s+FROM/iu)
  })

  it('scopes Calendar identity by provider account and calendar', () => {
    expect(sourceMigration).toContain('company_meetings_account_calendar_external_key')
    expect(sourceMigration).toContain('google_calendar_sync_states_account_calendar_key')
    expect(sourceMigration).toContain('ON DELETE RESTRICT')
  })

  it('enforces transcript expiry and introduces no recording payload', () => {
    expect(sourceMigration).toContain("INTERVAL '365 days'")
    expect(sourceMigration).not.toMatch(/recording_(?:bytes|data|payload|url)/iu)
    expect(sourceMigration).not.toMatch(/DROP\s+TABLE/iu)
  })
})
