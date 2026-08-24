import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { McpCapability } from '@pathfinder/contracts/mcp-v0'

const sql = readFileSync(
  new URL(
    '../../prisma/migrations/20260821200000_sync_mcp_credential_capabilities/migration.sql',
    import.meta.url,
  ),
  'utf8',
)
const capabilityMigrationPaths = [
  '20260821201000_add_meeting_processing_capability',
  '20260822223000_add_conversation_review_knowledge_draft_capabilities',
  '20260823030000_add_customer_access_requests',
  '20260823210000_add_location_proposal_capability',
  '20260823233000_add_agent_improvement_proposals',
  '20260824010000_add_agent_improvement_validation_evidence',
  '20260824160000_add_intake_machine_lineage',
  '20260824170000_add_weekly_report_draft_capability',
  '20260824180000_add_support_open_capability',
  '20260824190000_add_support_note_capability',
]
const capabilitySql = [
  sql,
  ...capabilityMigrationPaths.map((migration) =>
    readFileSync(
      new URL(`../../prisma/migrations/${migration}/migration.sql`, import.meta.url),
      'utf8',
    ),
  ),
].join('\n')

describe('MCP credential database capability parity', () => {
  it('admits every typed MCP capability while preserving the fail-closed evidence trigger', () => {
    for (const capability of McpCapability.options)
      expect(capabilitySql).toContain(`'${capability}'`)
    expect(sql).toContain('unsupported MCP credential capability')
    expect(sql).toContain('external credential capabilities must be sorted and unique')
    expect(sql).toContain('new external credential requires operation evidence')
    expect(sql).toContain('enabled external credential requires exact activation evidence')
  })
})
