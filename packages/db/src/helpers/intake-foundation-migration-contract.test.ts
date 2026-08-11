import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811210000_add_draft_intake_foundation/migration.sql',
  ),
  'utf8',
)
const tables = ['intake_runs', 'intake_evidence', 'intake_run_events', 'intake_package_handoffs']

describe('draft intake migration contract', () => {
  it('creates only draft proposal/evidence/event/handoff storage without data migration', () => {
    for (const table of tables) expect(sql).toContain(`CREATE TABLE "${table}"`)
    expect(sql).not.toMatch(/INSERT INTO|UPDATE\s+"(?:places|venue_packages)"|DELETE FROM/i)
    expect(sql).toContain("'AWAITING_REVIEW'")
  })
  it('pins run, evidence, events and package handoff to exact tenant and venue', () => {
    expect(sql).toContain('FOREIGN KEY ("run_id", "tenant_id", "venue_id", "source_kind")')
    expect(sql).toContain(
      'FOREIGN KEY ("package_draft_id", "tenant_id", "venue_id") REFERENCES "venue_packages"',
    )
    for (const table of tables)
      expect(sql).toContain(`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_venue_scope_fkey"`)
  })
  it('enforces typed website versus consented, classified text-only interview shape', () => {
    expect(sql).toContain(
      '"source_kind" = \'WEBSITE\' AND "website_uri" IS NOT NULL AND "interview_role" IS NULL',
    )
    expect(sql).toContain('"source_kind" = \'INTERVIEW\' AND "website_uri" IS NULL')
    expect(sql).toContain('"interview_public_answers" JSONB')
    expect(sql).toContain('"interview_answer_manifest" JSONB')
    expect(sql).toContain('"interview_consent_text_hash" CHAR(64)')
    expect(sql).not.toContain('"interview_text"')
  })
  it('makes every intake record append-only and exposes no approval/apply state', () => {
    for (const table of tables) {
      expect(sql).toContain(`${table}_append_only`)
      expect(sql).toContain(`${table}_no_truncate`)
    }
    expect(sql).not.toMatch(/AUTO_APPROV|AUTO_APPLY|PUBLISHED/)
  })
})
