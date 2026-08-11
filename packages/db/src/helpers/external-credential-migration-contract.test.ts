import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  fileURLToPath(
    new URL(
      '../../prisma/migrations/20260811230000_add_dark_external_credentials/migration.sql',
      import.meta.url,
    ),
  ),
  'utf8',
)

describe('dark external credential migration contract', () => {
  it('stores only one-way argon2id verifiers with exact tenant/client/venue scope', () => {
    expect(migration).toContain('"secret_hash" VARCHAR(255) NOT NULL')
    expect(migration).toContain('"external_credentials_argon2id_only"')
    expect(migration).toContain('"client_id" = "tenant_id"')
    expect(migration).toContain('"scope_key" = COALESCE("venue_id", \'__CLIENT__\')')
    expect(migration).not.toMatch(/plaintext|secret_value|raw_secret/iu)
  })

  it('binds rotation and revocation lineage to the same exact scope', () => {
    expect(migration).toContain('"external_rotations_previous_scope_fkey"')
    expect(migration).toContain('"external_rotations_new_scope_fkey"')
    expect(migration).toContain('"external_revocations_credential_scope_fkey"')
    expect(migration).toContain('"previous_credential_id" <> "new_credential_id"')
  })

  it('makes rotation and revocation evidence append-only including truncate', () => {
    for (const table of ['external_credential_rotations', 'external_credential_revocations']) {
      expect(migration).toContain(`${table}_append_only`)
      expect(migration).toContain(`${table}_no_truncate`)
    }
  })
})
