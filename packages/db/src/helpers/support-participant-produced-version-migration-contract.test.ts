import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260812001100_add_support_participant_produced_versions/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('support participant produced-version migration', () => {
  it('adds nullable paired evidence without reconstructing legacy outcomes', () => {
    expect(sql).toContain('ADD COLUMN "grant_request_version" INTEGER')
    expect(sql).toContain('ADD COLUMN "revoke_client_version" INTEGER')
    expect(sql).not.toMatch(/UPDATE\s+"support_request_participants"/u)
    expect(sql).toContain('support_participant_grant_evidence_check')
    expect(sql).toContain('support_participant_revoke_evidence_check')
    expect(sql.match(/DEFERRABLE INITIALLY DEFERRED/gu)).toHaveLength(2)
  })

  it('makes produced evidence immutable after it is recorded', () => {
    expect(sql).toContain('support_participant_operation_evidence_immutable')
    expect(sql).toContain('grant evidence is immutable')
    expect(sql).toContain('revoke evidence is immutable')
    expect(sql).toContain("TG_OP = 'INSERT'")
    expect(sql).toContain('new support participant requires complete grant evidence')
    expect(sql).toContain('support participant revoke requires complete evidence')
    expect(sql).toContain('legacy revoked participant evidence remains unknown')
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON "support_request_participants"')
  })
})
