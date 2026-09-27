import { describe, expect, it, vi } from 'vitest'

vi.mock('@pathfinder/db', () => ({
  db: { prospectOrganization: { findMany: vi.fn() } },
  withTenantIsolationBypass: (work: () => unknown) => work(),
}))

import {
  describeProspectGoodFitVenue,
  prospectGoodFitOrganizationWhere,
} from './prospect-crm-directory'
import { prospectGoodFitSavedView } from './prospect-crm-saved-views'

const fitAttributes = {
  torchikoSizeV1: {
    class: 'M',
    basis: 'seats',
    value: 1_200,
    unit: 'seats',
    sourceUrl: 'https://venue.example/about',
    observedAt: '2026-09-27',
    confidence: 'measured',
  },
  torchikoTriageV1: {
    normalizedType: 'museum',
    buyerAttainability: 'BUYER_SMALL_ATTAINABLE',
    fitTier: 'FIT_A',
    reviewVersion: 'torchiko-prospect-triage-v1.0.0',
  },
  torchikoFounderPriorityV1: {
    version: 'torchiko-founder-priority-v1.0.0',
    bucket: 'MID_TIER_PRIORITY',
  },
}

describe('prospect CRM Good fit view', () => {
  it('publishes the explicit editable Good fit saved-view rules', () => {
    expect(prospectGoodFitSavedView.name).toBe('Good fit')
    expect(prospectGoodFitSavedView.filters).toMatchObject({
      goodFit: true,
      sizeClasses: ['S', 'M', 'L'],
      preferredSizeClass: 'M',
      founderPriority: 'MID_TIER_PRIORITY',
      excludeEnterpriseDeferral: true,
      excludeOutboundCorrespondence: true,
      excludeCampaignMembership: true,
      excludeDrafts: true,
      excludeOpenOrConfirmedDuplicates: true,
    })
  })

  it('filters to supported S through L venues, founder priority or attainable buyer, territory, and no contact history', () => {
    const where = prospectGoodFitOrganizationWhere('chicago')
    const venueWhere = (where.venues as unknown as { some: unknown }).some
    expect(venueWhere).toMatchObject({
      estimatedSize: { in: ['S', 'M', 'L'] },
      organization: {
        is: {
          campaignMembers: { none: {} },
          outreachDrafts: { none: {} },
          emailMessages: { none: { direction: 'OUTBOUND' } },
          duplicateCandidatesA: { none: { status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] } } },
        },
      },
      activities: { none: { type: 'OUTREACH_SENT' } },
    })
    const serialized = JSON.stringify(venueWhere)
    expect(serialized).toContain('chicago')
    expect(serialized).toContain('arena')
    expect(serialized).toContain('stadium')
    expect(serialized).toContain('torchikoFounderPriorityV1')
    expect(serialized).toContain('MID_TIER_PRIORITY')
    expect(serialized).toContain('BUYER_SMALL_ATTAINABLE')
    expect(serialized).toContain('OUTREACH_SENT')
    expect(serialized).toContain('Chicago Bears')
  })

  it('explains the rules and rejects a Chicago Bears stadium fixture even when tagged as mid-size', () => {
    const bears = describeProspectGoodFitVenue({
      name: 'Soldier Field',
      venueType: 'museum',
      fitAttributes,
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Chicago Bears',
        organizationType: 'museum',
        territoryId: 'chicago',
      },
    })
    expect(bears.qualifies).toBe(false)
    expect(bears.excludedReason?.toLowerCase()).toContain('stadium')

    const venue = describeProspectGoodFitVenue(
      {
        name: 'Small History Museum',
        venueType: 'museum',
        fitAttributes,
        territoryId: 'different-territory',
        organization: {
          canonicalName: 'Small History Museum',
          organizationType: 'museum',
          territoryId: 'chicago',
        },
      },
      'chicago',
    )
    expect(venue.qualifies).toBe(true)
    expect(venue.reason).toContain('Founder priority is MID_TIER_PRIORITY')
    expect(venue.reason).toContain('Official seats evidence')
    expect(venue.unknown).toBeNull()

    const arena = describeProspectGoodFitVenue({
      name: 'Local Arts Arena',
      venueType: 'museum',
      fitAttributes,
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Local Arts Arena',
        organizationType: 'museum',
        territoryId: 'chicago',
      },
    })
    expect(arena.qualifies).toBe(false)
    expect(arena.excludedReason?.toLowerCase()).toContain('stadium or arena')
  })

  it('surfaces unknown size evidence instead of inventing a class', () => {
    const venue = describeProspectGoodFitVenue({
      name: 'Local Nature Center',
      venueType: 'nature center',
      fitAttributes: {},
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Local Nature Center',
        organizationType: 'nature center',
        territoryId: 'chicago',
      },
    })
    expect(venue.qualifies).toBe(false)
    expect(venue.unknown).toContain('not been established')
  })

  it('excludes enterprise buyers even if another fit field suggests priority', () => {
    const venue = describeProspectGoodFitVenue({
      name: 'Enterprise Museum',
      venueType: 'museum',
      fitAttributes: {
        ...fitAttributes,
        torchikoTriageV1: {
          ...fitAttributes.torchikoTriageV1,
          buyerAttainability: 'BUYER_ENTERPRISE',
        },
      },
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Enterprise Museum',
        organizationType: 'museum',
        territoryId: 'chicago',
      },
    })
    expect(venue.qualifies).toBe(false)

    const deferred = describeProspectGoodFitVenue({
      name: 'Named Enterprise Deferral',
      venueType: 'museum',
      fitAttributes: {
        ...fitAttributes,
        torchikoTriageV1: {
          ...fitAttributes.torchikoTriageV1,
          buyerAttainability: 'BUYER_SMALL_ATTAINABLE',
        },
        torchikoFounderPriorityV1: {
          ...fitAttributes.torchikoFounderPriorityV1,
          bucket: 'ENTERPRISE_DEFERRED',
        },
      },
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Named Enterprise Deferral',
        organizationType: 'museum',
        territoryId: 'chicago',
      },
    })
    expect(deferred.qualifies).toBe(false)

    const tagged = describeProspectGoodFitVenue({
      name: 'Tagged Museum',
      venueType: 'museum',
      fitAttributes,
      territoryId: 'chicago',
      organization: {
        canonicalName: 'Tagged Museum',
        organizationType: 'museum',
        territoryId: 'chicago',
        tags: ['enterprise-deferral'],
      },
    })
    expect(tagged.qualifies).toBe(false)
  })
})
