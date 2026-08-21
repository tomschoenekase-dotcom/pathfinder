import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const sql = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260821190000_add_company_brain_crm_meetings/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('company brain migration contract', () => {
  it('creates the institutional memory, CRM intelligence, and meeting foundations', () => {
    for (const table of [
      'company_knowledge_items',
      'company_decisions',
      'company_priorities',
      'account_relationship_notes',
      'account_milestones',
      'account_open_loops',
      'account_commitments',
      'account_summaries',
      'company_meetings',
      'company_meeting_extractions',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`)
    }
  })

  it('contains no destructive or unrelated schema drift', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX|CONSTRAINT|TYPE)\b/u)
    expect(sql).not.toContain('native_venue_deployment')
    expect(sql).not.toContain('venue_knowledge_entries')
  })

  it('includes indexes for current authority, timelines, and processing queues', () => {
    expect(sql).toContain('company_knowledge_scope_current_idx')
    expect(sql).toContain('account_open_loops_current_idx')
    expect(sql).toContain('company_meetings_processing_idx')
  })
})
