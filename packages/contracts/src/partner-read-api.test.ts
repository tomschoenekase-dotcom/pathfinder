import { describe, expect, it } from 'vitest'

import {
  assertPartnerReadScope,
  ListApprovedContentInput,
  PARTNER_READ_OPERATIONS,
  PartnerScopeError,
  validatePartnerReadCatalog,
  type PrevalidatedPartnerCredential,
} from './partner-read-api'

const credential: PrevalidatedPartnerCredential = {
  credentialId: 'key-1',
  tenantId: 'tenant-1',
  clientId: 'client-1',
  venueIds: ['venue-1'],
  capabilities: ['approved-content:read'],
}

describe('partner read API contracts', () => {
  it('publishes only dark, read-only, scoped v1 operations', () => {
    expect(() => validatePartnerReadCatalog()).not.toThrow()
    expect(PARTNER_READ_OPERATIONS).toHaveLength(6)
    for (const operation of PARTNER_READ_OPERATIONS) {
      expect(operation).toMatchObject({ version: 'v1', readOnly: true, public: false, risk: 'low' })
      expect(operation.capability).toBeTruthy()
      expect(operation.scope).toBeTruthy()
    }
  })

  it('rejects tenant authority and unknown arguments in public inputs', () => {
    expect(() =>
      ListApprovedContentInput.parse({
        tenantId: 'tenant-2',
        clientId: 'client-1',
        venueId: 'venue-1',
        limit: 25,
      }),
    ).toThrow()
  })

  it('rejects cross-client, cross-venue, and missing capability access', () => {
    expect(() =>
      assertPartnerReadScope(
        credential,
        { clientId: 'client-2', venueId: 'venue-1' },
        'approved-content:read',
        'venue',
      ),
    ).toThrow(PartnerScopeError)
    expect(() =>
      assertPartnerReadScope(
        credential,
        { clientId: 'client-1', venueId: 'venue-2' },
        'approved-content:read',
        'venue',
      ),
    ).toThrow(PartnerScopeError)
    expect(() =>
      assertPartnerReadScope(credential, { clientId: 'client-1' }, 'clients:read', 'client'),
    ).toThrow(PartnerScopeError)
  })
})
