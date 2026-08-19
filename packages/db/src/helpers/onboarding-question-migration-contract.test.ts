import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260818233000_link_onboarding_questions_to_support/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('onboarding question support-link migration contract', () => {
  it('binds the question, request, and answering message to one exact tenant and venue', () => {
    expect(sql).toContain(
      'FOREIGN KEY ("agent_question_id", "tenant_id", "venue_id") REFERENCES "agent_questions"("id", "tenant_id", "venue_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("support_request_id", "tenant_id", "venue_id") REFERENCES "support_requests"("id", "tenant_id", "venue_id")',
    )
    expect(sql).toContain(
      'FOREIGN KEY ("answered_support_message_id", "tenant_id", "venue_id", "support_request_id") REFERENCES "support_messages"("id", "tenant_id", "venue_id", "support_request_id")',
    )
  })

  it('enforces idempotent routing and a single durable answer claim', () => {
    expect(sql).toContain('"onboarding_question_links_tenant_operation_key"')
    expect(sql).toContain('"onboarding_question_links_question_scope_key"')
    expect(sql).toContain('"onboarding_question_links_request_scope_key"')
    expect(sql).toContain('"onboarding_question_links_answer_message_key"')
    expect(sql).toContain('"onboarding_question_links_resume_pair_check"')
  })

  it('keeps references restrictive so audit and resumption lineage cannot cascade away', () => {
    expect(sql.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g)?.length).toBeGreaterThanOrEqual(5)
    expect(sql).toContain('"onboarding_question_links_operation_hash_check"')
  })

  it('allows only the assigned active onboarding recipient to add a teammate', () => {
    expect(sql).toContain(
      'CREATE OR REPLACE FUNCTION pathfinder_guard_support_request_participant()',
    )
    expect(sql).toContain('link."recipient_user_id" = NEW."granted_by_id"')
    expect(sql).toContain('manager."revoked_at" IS NULL')
    expect(sql).toContain(
      'only the requester or assigned onboarding recipient may grant client participant access',
    )
  })
})
