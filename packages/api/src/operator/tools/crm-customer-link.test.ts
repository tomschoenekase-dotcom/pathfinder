import { describe, expect, it } from 'vitest'
import type { VerifiedOperatorGrant } from '../oauth'
import { projectCustomerLink } from './crm-customer-link'
const grant: VerifiedOperatorGrant = {
  grantId: 'grant-a',
  clientId: 'client-a',
  userId: 'operator-a',
  allTenants: false,
  tenantIds: ['tenant-a'],
  capabilities: ['crm:read'],
}
const at = new Date('2026-10-10T18:00:00.000Z')
const link = {
  tenantId: 'tenant-a',
  startedAt: at,
  locationConversions: [
    { tenantId: 'tenant-a', venueId: 'venue-a', venue: { tenantId: 'tenant-a' } },
  ],
}
describe('canonical CRM customer projection', () => {
  it('uses the canonical venue over an obsolete legacy conversion', () => {
    expect(
      projectCustomerLink({ tenantId: 'old', venueId: 'old', convertedAt: at }, [link], grant),
    ).toEqual({ tenantId: 'tenant-a', venueId: 'venue-a', convertedAt: at.toISOString() })
  })
  it('redacts links outside the grant and ambiguous account links', () => {
    expect(projectCustomerLink(null, [link], { ...grant, tenantIds: [] })).toMatchObject({
      tenantId: null,
      venueId: null,
    })
    expect(
      projectCustomerLink(null, [link, { ...link, tenantId: 'tenant-b' }], grant),
    ).toMatchObject({ tenantId: null, venueId: null })
  })
  it('never pairs a foreign or ambiguous venue with the customer', () => {
    for (const locations of [
      [{ ...link.locationConversions[0]!, tenantId: 'tenant-b' }],
      [{ ...link.locationConversions[0]!, venue: { tenantId: 'tenant-b' } }],
      [...link.locationConversions, ...link.locationConversions],
    ])
      expect(
        projectCustomerLink(null, [{ ...link, locationConversions: locations }], grant),
      ).toMatchObject({ tenantId: 'tenant-a', venueId: null })
  })
  it('retains legacy links only in the absence of canonical relationships', () => {
    expect(projectCustomerLink(null, [], grant)).toBeNull()
    expect(
      projectCustomerLink({ tenantId: 'tenant-a', venueId: 'venue-a', convertedAt: at }, [], grant),
    ).toMatchObject({ tenantId: 'tenant-a', venueId: 'venue-a' })
  })
})
