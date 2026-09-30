import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'
import { McpCapability } from '@pathfinder/contracts/mcp-v0'

const migrationsRoot = new URL('../../prisma/migrations/', import.meta.url)
const appearanceCapabilityMigration = '20260930100000_add_mcp_venue_appearance_capabilities'
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
    expect([...mcpAllowlist].sort()).toEqual(
      [
        ...new Set([
          ...McpCapability.options,
          'appearance:read',
          'appearance:write',
          'venues:create',
        ]),
      ].sort(),
    )
    expect(sql).toContain('unsupported MCP credential capability')
    expect(sql).toContain('unsupported partner credential capability')
    expect(sql).toContain('external credential capabilities must be sorted and unique')
    expect(sql).toContain('new external credential requires operation evidence')
    expect(sql).toContain('enabled external credential requires exact activation evidence')
    expect(sql).toContain('external credential revocation requires exact timestamp evidence')
  })

  it('keeps the appearance capability expansion in its own forward migration', () => {
    expect(latestDefinition).toBe(appearanceCapabilityMigration)
    expect(mcpAllowlist).toContain('appearance:read')
    expect(mcpAllowlist).toContain('appearance:write')
    expect(mcpAllowlist).toContain('venues:create')
    expect(mcpAllowlist).toContain('venues:read')
    expect(sql).toContain('NEW."kind" = \'PARTNER_READ_API\'')
    expect(sql).toContain('ALTER COLUMN "venue_id" DROP NOT NULL')
    expect(sql).toContain('NEW."venue_id" IS NOT NULL')
    expect(sql).toContain('NEW."scope_key" <> \'__CLIENT__\'')
    expect(sql).toContain(
      "ARRAY['venues:read','venues:create','appearance:read','appearance:write']::TEXT[]",
    )
    expect(sql).toContain('IF NEW."venue_id" IS NOT NULL THEN')
    expect(sql).toContain('\'agent-runs:execute\' = ANY(credential."capabilities")')
    expect(sql).toContain('activation."venue_id" IS NOT DISTINCT FROM NEW."venue_id"')
    expect(sql).not.toContain('DROP TRIGGER')
    expect(sql).not.toContain('INSERT INTO')
    expect(sql).not.toContain('UPDATE ')
    expect(sql).not.toContain('DELETE FROM')
  })
})
