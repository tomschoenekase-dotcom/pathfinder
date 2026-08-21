import { describe, expect, it, vi } from 'vitest'

import { getCompactAccountContext } from './account-context'

const date = new Date('2030-01-01T12:00:00.000Z')

function organizationFixture() {
  return {
    id: 'org_1',
    canonicalName: 'Museum Y',
    organizationType: 'MUSEUM',
    description: null,
    headquartersCity: 'Chicago',
    headquartersRegion: 'IL',
    headquartersCountry: 'US',
    relationshipTier: 'ACTIVE_CLIENT',
    createdAt: date,
    updatedAt: date,
    contacts: [
      {
        id: 'contact_1',
        fullName: 'Jane Curator',
        title: 'Director',
        email: 'jane@example.test',
        phone: null,
        preferredCommunication: 'EMAIL',
        doNotContact: false,
        suppressionReason: null,
        updatedAt: date,
      },
    ],
    opportunity: null,
    conversion: { id: 'conversion_1', tenantId: 'tenant_1', venueId: 'venue_1', convertedAt: date },
    customerRelationships: [
      {
        id: 'relationship_1',
        status: 'ACTIVE',
        relationshipVersion: 1,
        startedAt: date,
        updatedAt: date,
        tenant: {
          id: 'tenant_1',
          name: 'Museum Y',
          status: 'ACTIVE',
          planTier: 'STARTER',
          billingAccount: null,
          commercialAgreements: [],
          venues: [
            {
              id: 'venue_1',
              name: 'Museum Y',
              category: 'MUSEUM',
              isActive: true,
              secondLayerEnabled: false,
              createdAt: date,
              updatedAt: date,
              intakeRuns: [],
              supportRequests: [],
            },
          ],
        },
      },
    ],
    activities: [],
    emailMessages: [],
    companyMeetings: [],
    relationshipNotes: [
      {
        id: 'note_1',
        category: 'COMMUNICATION_PREFERENCE',
        body: 'Prefers concise email.',
        authority: 'DURABLE_CONTEXT',
        confidence: null,
        sourceType: 'MEETING',
        sourceId: 'meeting_1',
        sourceRef: null,
        effectiveAt: date,
        lastConfirmedAt: date,
        updatedAt: date,
      },
    ],
    milestones: [],
    openLoops: [],
    commitments: [],
    summaries: [],
  }
}

describe('compact account context', () => {
  it('enforces active tenant scope in the database query and keeps source bodies out', async () => {
    const findFirst = vi.fn().mockResolvedValue(organizationFixture())
    const result = await getCompactAccountContext(
      { clientId: 'tenant_1', organizationId: 'org_1' },
      { prospectOrganization: { findFirst } } as never,
    )

    const query = findFirst.mock.calls[0]?.[0]
    expect(query.where).toMatchObject({
      id: 'org_1',
      customerRelationships: { some: { tenantId: 'tenant_1', status: 'ACTIVE' } },
    })
    expect(query.select.emailMessages.select).not.toHaveProperty('body')
    expect(query.select.contacts.take).toBe(5)
    expect(query.select.customerRelationships.take).toBe(1)
    expect(result.identity.canonicalName).toBe('Museum Y')
    expect(result.relationship.notes[0]).toMatchObject({
      body: 'Prefers concise email.',
      provenance: { sourceType: 'MEETING', sourceId: 'meeting_1' },
    })
    expect(result.payload.collectionsBounded).toBe(true)
  })

  it('does not reveal whether an account exists outside verified scope', async () => {
    const client = { prospectOrganization: { findFirst: vi.fn().mockResolvedValue(null) } }
    await expect(
      getCompactAccountContext(
        { clientId: 'tenant_other', organizationId: 'org_1' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('rejects an out-of-scope venue without returning the account projection', async () => {
    const fixture = organizationFixture()
    fixture.customerRelationships[0]!.tenant.venues = []
    const client = { prospectOrganization: { findFirst: vi.fn().mockResolvedValue(fixture) } }
    await expect(
      getCompactAccountContext(
        { clientId: 'tenant_1', organizationId: 'org_1', venueId: 'venue_other' },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
