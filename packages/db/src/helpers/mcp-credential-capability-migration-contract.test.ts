import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { McpCapability } from '@pathfinder/contracts/mcp-v0'

const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const latestDefinition = readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .reverse()
  .find((name) =>
    readFileSync(new URL(`${name}/migration.sql`, migrationsRoot), 'utf8').includes(
      'CREATE OR REPLACE FUNCTION pathfinder_check_external_credential_evidence()',
    ),
  )
if (!latestDefinition) throw new Error('Missing current credential evidence trigger definition')
const sql = readFileSync(new URL(`${latestDefinition}/migration.sql`, migrationsRoot), 'utf8')

const mcpAllowlistMatch = sql.match(/NEW\."kind" = 'MCP'[\s\S]*?<@ ARRAY\[([^\]]*)\]::TEXT\[\]/)
const mcpAllowlist = [...(mcpAllowlistMatch?.[1]?.matchAll(/'([^']+)'/g) ?? [])].map(
  ([, capability]) => capability,
)

describe('MCP credential database capability parity', () => {
  it('admits every typed MCP capability while preserving the fail-closed evidence trigger', () => {
    expect(mcpAllowlistMatch).not.toBeNull()
    expect([...mcpAllowlist].sort()).toEqual([...McpCapability.options].sort())
    expect(sql).toContain('unsupported MCP credential capability')
    expect(sql).toContain('unsupported partner credential capability')
    expect(sql).toContain('external credential capabilities must be sorted and unique')
    expect(sql).toContain('new external credential requires operation evidence')
    expect(sql).toContain('enabled external credential requires exact activation evidence')
    expect(sql).toContain('external credential revocation requires exact timestamp evidence')
  })
})
