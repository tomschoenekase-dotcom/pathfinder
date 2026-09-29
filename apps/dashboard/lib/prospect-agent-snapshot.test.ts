import { describe, expect, it } from 'vitest'

import {
  buildProspectAgentSnapshotOrganization,
  emptySnapshotOutreach,
  isSnapshotContactSuppressed,
  prospectAgentSnapshotFileName,
  type SnapshotContactInput,
  type SnapshotOrganizationInput,
} from './prospect-agent-snapshot'

function contact(overrides: Partial<SnapshotContactInput> = {}): SnapshotContactInput {
  return {
    id: 'contact-1',
    venueId: 'venue-1',
    fullName: 'Sample Person',
    title: 'Director',
    email: 'sample@example.com',
    phone: '555-0100',
    emailReadiness: 'VALID',
    permissionState: 'UNKNOWN',
    doNotContact: false,
    suppressionReason: null,
    suppressedAt: null,
    unsubscribedAt: null,
    complainedAt: null,
    lastHardBounceAt: null,
    ...overrides,
  }
}

function organization(
  overrides: Partial<SnapshotOrganizationInput> = {},
): SnapshotOrganizationInput {
  return {
    id: 'org-1',
    canonicalName: 'Sample Science Museum',
    website: 'https://museum.example.com',
    organizationType: 'museum',
    headquartersCity: 'Sampleton',
    headquartersRegion: 'IL',
    headquartersCountry: 'US',
    relationshipTier: 'STANDARD',
    notes: null,
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    opportunity: {
      stage: 'RESEARCHED',
      priority: 'NORMAL',
      nextAction: null,
      nextActionAt: null,
      lastActivityAt: null,
    },
    venues: [
      {
        id: 'venue-1',
        name: 'Sample Science Museum',
        website: null,
        venueType: 'museum',
        city: 'Sampleton',
        region: 'IL',
        country: 'US',
        estimatedSize: 'M',
        fitAttributes: {
          torchikoTriageV1: { bucket: 'GOOD' },
          internalProvenance: { secret: 'never exported' },
        },
      },
    ],
    contacts: [contact()],
    tagAssignments: [
      { tag: { slug: 'mid-tier', label: 'Mid tier', archivedAt: null } },
      { tag: { slug: 'old-tag', label: 'Old', archivedAt: new Date('2026-01-01T00:00:00Z') } },
    ],
    ...overrides,
  }
}

describe('prospect agent snapshot', () => {
  it('keeps a reachable contact and marks an untouched organization as never contacted', () => {
    const record = buildProspectAgentSnapshotOrganization(organization(), emptySnapshotOutreach())

    expect(record.contacts[0]).toMatchObject({ email: 'sample@example.com', suppressed: false })
    expect(record.outreach).toMatchObject({
      everContacted: false,
      doNotContact: false,
      crmDrafts: 0,
    })
    expect(record.tags).toEqual(['mid-tier'])
  })

  it.each([
    ['doNotContact', { doNotContact: true }],
    ['suppressedAt', { suppressedAt: new Date('2026-09-02T00:00:00Z') }],
    ['unsubscribedAt', { unsubscribedAt: new Date('2026-09-02T00:00:00Z') }],
    ['complainedAt', { complainedAt: new Date('2026-09-02T00:00:00Z') }],
    ['opted out', { permissionState: 'OPTED_OUT' }],
    ['prohibited', { permissionState: 'PROHIBITED' }],
  ])('omits email and phone for a %s contact but keeps the flag', (_label, overrides) => {
    const suppressed = contact(overrides)
    expect(isSnapshotContactSuppressed(suppressed)).toBe(true)

    const record = buildProspectAgentSnapshotOrganization(
      organization({ contacts: [suppressed] }),
      emptySnapshotOutreach(),
    )

    expect(record.contacts[0]).toMatchObject({ email: null, phone: null, suppressed: true })
    expect(record.outreach.doNotContact).toBe(true)
    expect(JSON.stringify(record)).not.toContain('sample@example.com')
  })

  it.each([
    ['an outbound message', { outbound: { count: 1, last: new Date('2026-09-03T00:00:00Z') } }],
    [
      'a sent activity',
      {
        activity: {
          lastOutreachSentAt: new Date('2026-09-03T00:00:00Z'),
          lastReplyReceivedAt: null,
        },
      },
    ],
    [
      'a sent campaign member',
      { campaigns: [{ name: 'Fall', campaignStatus: 'ACTIVE', memberStatus: 'SENT' }] },
    ],
    ['a queued CRM draft', { draftsByStatus: { QUEUED: 1 } }],
  ])('marks an organization contacted after %s', (_label, overrides) => {
    const record = buildProspectAgentSnapshotOrganization(organization(), {
      ...emptySnapshotOutreach(),
      ...overrides,
    })
    expect(record.outreach.everContacted).toBe(true)
  })

  it('treats a contacted stage as contacted and do-not-contact stage as suppressed', () => {
    const base = organization().opportunity!
    const contacted = buildProspectAgentSnapshotOrganization(
      organization({ opportunity: { ...base, stage: 'REPLIED' } }),
      emptySnapshotOutreach(),
    )
    const blocked = buildProspectAgentSnapshotOrganization(
      organization({ opportunity: { ...base, stage: 'DO_NOT_CONTACT' } }),
      emptySnapshotOutreach(),
    )
    expect(contacted.outreach.everContacted).toBe(true)
    expect(blocked.outreach.doNotContact).toBe(true)
  })

  it('exports only allowlisted fit attributes and truncates long notes', () => {
    const record = buildProspectAgentSnapshotOrganization(
      organization({ notes: 'x'.repeat(900) }),
      emptySnapshotOutreach(),
    )
    expect(record.venues[0]!.fit).toEqual({ torchikoTriageV1: { bucket: 'GOOD' } })
    expect(record.notes).toHaveLength(500)
  })

  it('uses the latest of message and activity timestamps', () => {
    const record = buildProspectAgentSnapshotOrganization(organization(), {
      ...emptySnapshotOutreach(),
      outbound: { count: 1, last: new Date('2026-09-03T00:00:00Z') },
      activity: {
        lastOutreachSentAt: new Date('2026-09-05T00:00:00Z'),
        lastReplyReceivedAt: null,
      },
    })
    expect(record.outreach.lastOutboundAt).toBe('2026-09-05T00:00:00.000Z')
  })

  it('names the file with a filesystem-safe UTC timestamp', () => {
    expect(prospectAgentSnapshotFileName(new Date('2026-09-28T17:05:09.123Z'))).toBe(
      'torchiko-crm-snapshot-2026-09-28T17-05-09-123Z.json',
    )
  })
})
