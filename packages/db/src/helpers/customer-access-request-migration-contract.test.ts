import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    import.meta.dirname,
    '../../prisma/migrations/20260823030000_add_customer_access_requests/migration.sql',
  ),
  'utf8',
)

describe('customer access request migration contract', () => {
  it('keeps invitation preparation provider-dark, tenant-scoped, and lifecycle guarded', () => {
    expect(migration).toContain('customer_access_requests_active_email_key')
    expect(migration).toContain('pathfinder_guard_customer_access_request')
    expect(migration).toContain('customer_access_requests_lifecycle_guard')
    expect(migration).toContain('NEW."status" <> \'AWAITING_APPROVAL\'')
    expect(migration).toContain('NEW."provider_invitation_id" IS NOT NULL')
    expect(migration).toContain('customer access request evidence is immutable')
    expect(migration).toContain("'customer-access:prepare'")
    expect(migration).toContain('customer_access_requests_email_shape_check')
  })
})
