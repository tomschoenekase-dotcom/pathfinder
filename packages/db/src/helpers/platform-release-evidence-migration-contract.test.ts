import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { PLATFORM_TABLES } from '../tenanted-tables'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260825006000_add_platform_release_evidence/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('platform release evidence migration', () => {
  it('is additive, platform-scoped, attributable, and append-only', () => {
    expect(sql).toContain('CREATE TABLE "platform_release_evidence"')
    expect(sql).toContain('platform_release_evidence_agent_credential')
    expect(sql).toContain('REFERENCES "platform_worker_policy_credentials"')
    expect(sql).toContain('platform release evidence is append-only')
    expect(sql).toContain('platform_release_evidence_ready_is_green')
    expect(sql).toContain("\"profile\" IN ('local', 'candidate', 'staging')")
    expect(sql).toContain(
      "\"readiness\" IN ('ready-local', 'ready-for-staging-review', 'ready', 'not-ready')",
    )
    expect(sql).toContain('BEFORE TRUNCATE')
    expect(sql).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE TABLE/iu)
    expect(PLATFORM_TABLES).toContain('PlatformReleaseEvidence')
  })
})
