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
const capabilitySql = `${sql}\n${readFileSync(
  new URL(
    '../../prisma/migrations/20260821201000_add_meeting_processing_capability/migration.sql',
    import.meta.url,
  ),
  'utf8',
)}\n${readFileSync(
  new URL(
    '../../prisma/migrations/20260822223000_add_conversation_review_knowledge_draft_capabilities/migration.sql',
    import.meta.url,
  ),
  'utf8',
)}`

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
