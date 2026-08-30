import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260825012000_align_agent_runtime_model_routing/migration.sql',
  ),
  'utf8',
)

describe('agent runtime routing migration contract', () => {
  it('moves legacy direct identities to the central route and rejects incoherent routing state', () => {
    expect(migration).toContain('SET "default_provider" = \'anthropic\'')
    expect(migration).toContain('"default_model" = \'central:agent-run\'')
    expect(migration).toContain('"default_provider" = \'anthropic\'')
    expect(migration).toContain(
      "lower(\"default_provider\") IN ('anthropic', 'claude', 'claude-api')",
    )
    expect(migration).toContain(
      'agent identity execution routing contains unsupported legacy values',
    )
    expect(migration).toContain('agent_identities_execution_route_check')
    expect(migration).toContain("'hermes-bridge'")
    expect(migration).toContain('"default_model" <> \'central:agent-run\'')
  })
})
