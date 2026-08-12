import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'prisma/migrations/20260811235900_add_client_create_intents/migration.sql',
  ),
  'utf8',
)

describe('client-create intent migration contract', () => {
  it('is additive, uniquely binds request/provider/tenant identities, and makes evidence append-only', () => {
    expect(migration).toContain('CREATE TABLE "client_create_intents"')
    expect(migration).toContain('"request_id" UUID NOT NULL')
    expect(migration).toContain('client_create_intents_request_id_key')
    expect(migration).toContain('client_create_intents_provider_organization_id_key')
    expect(migration).toContain('client_create_intents_completed_tenant_id_key')
    expect(migration.trimStart()).toMatch(/^BEGIN;/u)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/u)
    expect(migration).toContain('client_create_intents_lifecycle_fields_check')
    expect(migration).toContain('client_create_intents_state_machine')
    expect(migration).toContain(
      'OLD."status" = \'RESERVED\' AND NEW."status" = \'PROVIDER_STARTED\'',
    )
    expect(migration).toContain(
      'OLD."status" = \'PROVIDER_STARTED\' AND NEW."status" = \'PROVIDER_CONFIRMED\'',
    )
    expect(migration).toContain(
      'OLD."status" = \'PROVIDER_CONFIRMED\' AND NEW."status" = \'COMPLETED\'',
    )
    expect(migration).toContain('client create intent identity and claims are immutable')
    expect(migration).toContain('client_create_intent_events_append_only_update')
    expect(migration).toContain('client_create_intent_events_append_only_delete')
    expect(migration).toContain('client_create_intent_events_append_only_truncate')
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|COLUMN|TYPE)/iu)
    expect(migration).not.toMatch(/password|email|secret|token/iu)
  })
})
