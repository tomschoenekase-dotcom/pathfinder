import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  new URL(
    '../../prisma/migrations/20260818213000_activate_agent_bridge_credentials/migration.sql',
    import.meta.url,
  ),
  'utf8',
)

describe('agent bridge credential activation migration', () => {
  it('requires append-only exact-scope activation evidence without storing plaintext', () => {
    expect(migration).toContain('external_credential_activations_append_only')
    expect(migration).toContain('external_credential_activations_no_truncate')
    expect(migration).toContain('bridge activation requires exact active MCP credential evidence')
    expect(migration).toContain("'agent-runs:execute' = ANY")
    expect(migration).not.toMatch(/plaintext|browser|subscription_token/iu)
  })

  it('permits only reviewed activation or terminal revocation and expands the MCP capability gate', () => {
    expect(migration).toContain('only exact bridge activation or terminal revocation is allowed')
    expect(migration).toContain('enabled external credential requires exact activation evidence')
    for (const capability of [
      'agent-runs:execute',
      'delegations:create',
      'questions:ask',
      'questions:read',
    ]) {
      expect(migration).toContain(`'${capability}'`)
    }
  })
})
