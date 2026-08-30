import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    __dirname,
    '../../prisma/migrations/20260823103000_add_platform_worker_policy_credentials/migration.sql',
  ),
  'utf8',
)

describe('platform worker policy credential migration', () => {
  it('is platform-scoped, default dark, one-way verified, and lifecycle constrained', () => {
    expect(migration).toContain('"enabled" BOOLEAN NOT NULL DEFAULT false')
    expect(migration).toContain('"platform_worker_policy_argon2id_only"')
    expect(migration).toContain('"platform_worker_policy_revoked_disabled"')
    expect(migration).not.toContain('tenant_id')
    expect(migration).not.toContain('client_id')
    expect(migration).not.toContain('venue_id')
  })
})
