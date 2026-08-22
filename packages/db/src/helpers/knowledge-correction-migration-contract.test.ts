import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260822223000_add_conversation_review_knowledge_draft_capabilities/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('knowledge correction migration contract', () => {
  it('admits only the named MCP capabilities and prevents concurrent active insight proposals', () => {
    expect(sql).toContain("'conversations:review'")
    expect(sql).toContain("'knowledge:draft'")
    expect(sql).toContain('unsupported MCP credential capability')
    expect(sql).toContain('knowledge_change_proposals_active_insight_key')
    expect(sql).toContain('"conversation_insight_id" IS NOT NULL')
    expect(sql).toContain("'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PUBLISHED'")
    expect(sql).not.toContain('UPDATE "knowledge_change_proposals"')
    expect(sql).not.toContain('DELETE FROM "knowledge_change_proposals"')
  })
})
