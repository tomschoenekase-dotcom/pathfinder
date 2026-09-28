import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ prospectVenueFindMany: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  db: {
    prospectOrganization: { findMany: vi.fn() },
    prospectVenue: { findMany: mocks.prospectVenueFindMany },
  },
  withTenantIsolationBypass: (work: () => unknown) => work(),
}))

import {
  describeProspectGoodFitVenue,
  prospectGoodFitOrganizationWhere,
} from './prospect-crm-directory'
import { prospectGoodFitSavedView } from './prospect-crm-saved-views'
import { defaultProspectGoodFitRules } from '@pathfinder/contracts/prospect-size'
import { router } from '../../core'
import type { TRPCContext } from '../../context'
import { adminProspectCrmIntelligenceRouter } from './prospect-crm-intelligence'

const assistantRouter = router({ crm: adminProspectCrmIntelligenceRouter })

function context(): TRPCContext {
  return {
    db: {} as TRPCContext['db'],
    headers: new Headers(),
    session: { userId: 'admin_1', activeTenantId: null, role: null, isPlatformAdmin: true },
  }
}

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
  it('filters requested categories before limiting each size band', async () => {
    const candidate = (
      id: string,
      normalizedType: string,
      venueType = normalizedType,
      organizationType = normalizedType,
    ) => ({
      id,
      name: id,
      city: 'Chicago',
      region: 'IL',
      venueType,
      territoryId: 'chicago',
      estimatedSize: 'M',
      fitAttributes: {
        ...fitAttributes,
        torchikoTriageV1: { ...fitAttributes.torchikoTriageV1, normalizedType },
      },
      organization: {
        id: `org-${id}`,
        canonicalName: id,
        organizationType,
        territoryId: 'chicago',
      },
    })
    const newestFirst = [
      candidate('Zoo 1', 'zoo'),
      candidate('Zoo 2', 'zoo'),
      candidate('Zoo 3', 'zoo'),
      candidate('Zoo 4', 'zoo'),
      candidate('Natural History Museum', 'museum', 'Natural History Museum'),
    ]
    mocks.prospectVenueFindMany.mockImplementation(
      async (args: { take: number; where: { AND: unknown[] } }) => {
        const query = JSON.stringify(args.where).toLowerCase()
        const categoryWasPushedDown = query.includes('"string_contains":"museum"')
        return (
          categoryWasPushedDown
            ? newestFirst.filter((venue) =>
                [venue.venueType, venue.organization.organizationType].some((value) =>
                  value.toLowerCase().includes('museum'),
                ),
              )
            : newestFirst
        ).slice(0, args.take)
      },
    )

    const result = await assistantRouter
      .createCaller(context())
      .crm.findProspectsForAssistant({ ask: 'museum', territoryId: 'chicago', limit: 1 })

    expect(result.items.map((item) => item.venueName)).toEqual(['Natural History Museum'])
    expect(mocks.prospectVenueFindMany).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(mocks.prospectVenueFindMany.mock.calls[0]?.[0].where)).toContain(
      '"string_contains":"museum"',
    )
    expect(mocks.prospectVenueFindMany.mock.calls[0]?.[0].take).toBe(4)
  })

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

  it('honors a saved view variation while preserving the conservative default', () => {
    const custom = {
      ...defaultProspectGoodFitRules,
      sizeClasses: ['XS' as const],
      supportedCategories: ['museum'],
      requireTerritory: false,
      excludeCampaignMembership: false,
      excludeDrafts: false,
      excludeOutboundCorrespondence: false,
      excludeOpenOrConfirmedDuplicates: false,
    }
    const where = prospectGoodFitOrganizationWhere(undefined, custom)
    const venueWhere = (where.venues as unknown as { some: Record<string, unknown> }).some
    expect(venueWhere.estimatedSize).toEqual({ in: ['XS'] })
    expect(venueWhere.campaignMembers).toBeUndefined()
    expect(venueWhere.outreachDrafts).toBeUndefined()
    expect(venueWhere.emailMessages).toBeUndefined()
    expect(where.OR).toBeUndefined()
    const customVenue = describeProspectGoodFitVenue(
      {
        name: 'Unassigned Tiny Museum',
        venueType: 'museum',
        fitAttributes: {
          ...fitAttributes,
          torchikoSizeV1: {
            ...fitAttributes.torchikoSizeV1,
            class: 'XS',
            value: 80,
          },
        },
        territoryId: null,
        organization: {
          canonicalName: 'Unassigned Tiny Museum',
          organizationType: 'museum',
          territoryId: null,
        },
      },
      undefined,
      custom,
    )
    expect(customVenue.qualifies).toBe(true)
    expect(
      describeProspectGoodFitVenue({
        name: 'Unassigned Tiny Museum',
        venueType: 'museum',
        fitAttributes: {
          ...fitAttributes,
          torchikoSizeV1: { ...fitAttributes.torchikoSizeV1, class: 'XS', value: 80 },
        },
        territoryId: null,
        organization: {
          canonicalName: 'Unassigned Tiny Museum',
          organizationType: 'museum',
          territoryId: null,
        },
      }).qualifies,
    ).toBe(false)
  })
})
