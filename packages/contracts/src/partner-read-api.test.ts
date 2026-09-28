import { describe, expect, it } from 'vitest'

import {
  assertPartnerReadScope,
  ListApprovedContentInput,
  PARTNER_HTTP_ROUTE_BINDINGS,
  PARTNER_READ_OPERATIONS,
  PartnerGuideProjection,
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
    expect(PARTNER_READ_OPERATIONS).toHaveLength(8)
    for (const operation of PARTNER_READ_OPERATIONS) {
      expect(operation).toMatchObject({ version: 'v1', readOnly: true, public: false, risk: 'low' })
      expect(operation.capability).toBeTruthy()
      expect(operation.scope).toBeTruthy()
    }
  })

  it('maps every read operation to one unique, versioned GET route', () => {
    expect(PARTNER_HTTP_ROUTE_BINDINGS).toEqual([
      { method: 'GET', path: '/api/partner/v1/client', operation: 'clients.get' },
      { method: 'GET', path: '/api/partner/v1/venues', operation: 'venues.list' },
      { method: 'GET', path: '/api/partner/v1/venues/{venueId}', operation: 'venues.get' },
      {
        method: 'GET',
        path: '/api/partner/v1/venues/{venueId}/content',
        operation: 'approved-content.list',
      },
      {
        method: 'GET',
        path: '/api/partner/v1/venues/{venueId}/configuration',
        operation: 'configuration.get',
      },
      {
        method: 'GET',
        path: '/api/partner/v1/venues/{venueId}/guide',
        operation: 'guide.get',
      },
      {
        method: 'GET',
        path: '/api/partner/v1/venues/{venueId}/readiness',
        operation: 'readiness.get',
      },
      {
        method: 'GET',
        path: '/api/partner/v1/venues/{venueId}/updates',
        operation: 'updates.list',
      },
    ])
  })

  it('allows only canonical app guide URLs and the host background theme token', () => {
    const guide = {
      venueId: 'venue-1',
      urls: {
        app: 'https://guide.example.com/app/museum',
        compactApp: 'https://guide.example.com/app/museum?header=compact',
      },
      theme: { appBackground: '#0d1116' },
    }
    expect(PartnerGuideProjection.parse(guide)).toEqual(guide)
    expect(() =>
      PartnerGuideProjection.parse({
        ...guide,
        urls: { ...guide.urls, admin: 'https://evil.test' },
      }),
    ).toThrow()
    expect(() =>
      PartnerGuideProjection.parse({
        ...guide,
        theme: { appBackground: 'url(javascript:alert(1))' },
      }),
    ).toThrow()
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
