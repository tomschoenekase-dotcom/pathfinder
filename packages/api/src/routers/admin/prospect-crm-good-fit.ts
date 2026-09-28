import {
  defaultProspectGoodFitRules,
  explainProspectSize,
  prospectCategorySizeRule,
  prospectGoodFitCriteria,
  type ProspectGoodFitRules,
} from '@pathfinder/contracts/prospect-size'
import type { ProspectOrganizationWhereInput, ProspectVenueWhereInput } from '@pathfinder/db'
export function prospectGoodFitVenueWhere(
  territoryId?: string,
  rules: ProspectGoodFitRules = defaultProspectGoodFitRules,
): ProspectVenueWhereInput {
  const categories = rules.supportedCategories.map((category) => category.trim().toLowerCase())
  const scopedTerritory = territoryId || rules.requireTerritory
  const priorityClauses: ProspectVenueWhereInput[] = [
    {
      fitAttributes: {
        path: ['torchikoFounderPriorityV1', 'bucket'],
        equals: rules.founderPriority,
      },
    },
    ...rules.buyerAttainabilityAnyOf.map((value) => ({
      fitAttributes: { path: ['torchikoTriageV1', 'buyerAttainability'], equals: value },
    })),
  ]
  return {
    archivedAt: null,
    estimatedSize: { in: rules.sizeClasses },
    AND: [
      ...(scopedTerritory
        ? [
            {
              OR: territoryId
                ? [{ territoryId }, { organization: { is: { territoryId } } }]
                : [
                    { territoryId: { not: null } },
                    { organization: { is: { territoryId: { not: null } } } },
                  ],
            },
          ]
        : []),
      {
        OR: rules.sizeClasses.map((sizeClass) => ({
          fitAttributes: { path: ['torchikoSizeV1', 'class'], equals: sizeClass },
        })),
      },
      { OR: priorityClauses },
      {
        OR: [
          ...categories.map((value) => ({
            fitAttributes: { path: ['torchikoTriageV1', 'normalizedType'], equals: value },
          })),
          { venueType: { in: categories, mode: 'insensitive' as const } },
          {
            organization: {
              is: {
                organizationType: { in: categories, mode: 'insensitive' as const },
              },
            },
          },
        ],
      },
      ...(rules.excludeStadiumArena
        ? [
            {
              NOT: [
                { name: { contains: 'Soldier Field', mode: 'insensitive' as const } },
                { name: { contains: 'library', mode: 'insensitive' as const } },
                { name: { contains: 'stadium', mode: 'insensitive' as const } },
                { name: { contains: 'arena', mode: 'insensitive' as const } },
                {
                  organization: {
                    is: {
                      canonicalName: { contains: 'Chicago Bears', mode: 'insensitive' as const },
                    },
                  },
                },
              ],
            },
          ]
        : []),
    ],
    ...(rules.excludeCampaignMembership ? { campaignMembers: { none: {} } } : {}),
    ...(rules.excludeDrafts ? { outreachDrafts: { none: {} } } : {}),
    ...(rules.excludeOutboundCorrespondence
      ? {
          emailMessages: { none: { direction: 'OUTBOUND' as const } },
          activities: { none: { type: 'OUTREACH_SENT' as const } },
        }
      : {}),
    organization: {
      is: {
        archivedAt: null,
        ...(rules.excludeCampaignMembership ? { campaignMembers: { none: {} } } : {}),
        ...(rules.excludeDrafts ? { outreachDrafts: { none: {} } } : {}),
        ...(rules.excludeOutboundCorrespondence
          ? {
              emailMessages: { none: { direction: 'OUTBOUND' as const } },
              activities: { none: { type: 'OUTREACH_SENT' as const } },
            }
          : {}),
        ...(rules.excludeOpenOrConfirmedDuplicates
          ? {
              duplicateCandidatesA: {
                none: { status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] as const } },
              },
              duplicateCandidatesB: {
                none: { status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] as const } },
              },
            }
          : {}),
      },
    },
  }
}
export function prospectGoodFitOrganizationWhere(
  territoryId?: string,
  rules: ProspectGoodFitRules = defaultProspectGoodFitRules,
): ProspectOrganizationWhereInput {
  return {
    venues: { some: prospectGoodFitVenueWhere(territoryId, rules) },
    ...(territoryId
      ? {
          OR: [{ territoryId }, { venues: { some: { territoryId } } }],
        }
      : rules.requireTerritory
        ? {
            OR: [
              { territoryId: { not: null } },
              { venues: { some: { territoryId: { not: null } } } },
            ],
          }
        : {}),
  }
}

export function describeProspectGoodFitVenue(
  venue: {
    venueType: string | null
    name: string
    fitAttributes: unknown
    territoryId: string | null
    organization: {
      canonicalName: string
      organizationType: string | null
      territoryId: string | null
      tags?: unknown
    }
  },
  territoryId?: string,
  rules: ProspectGoodFitRules = defaultProspectGoodFitRules,
) {
  const size = explainProspectSize(venue.fitAttributes)
  const attributes =
    venue.fitAttributes && typeof venue.fitAttributes === 'object'
      ? (venue.fitAttributes as Record<string, unknown>)
      : {}
  const triage =
    attributes.torchikoTriageV1 && typeof attributes.torchikoTriageV1 === 'object'
      ? (attributes.torchikoTriageV1 as Record<string, unknown>)
      : {}
  const founderPriority = attributes.torchikoFounderPriorityV1
  const founder =
    founderPriority && typeof founderPriority === 'object'
      ? (founderPriority as Record<string, unknown>)
      : {}
  const founderBucket = founder.bucket
  const buyerAttainability = triage.buyerAttainability
  const qualifyingPriority =
    founderBucket === rules.founderPriority ||
    rules.buyerAttainabilityAnyOf.includes(String(buyerAttainability))
  const enterpriseDeferred =
    buyerAttainability === 'BUYER_ENTERPRISE' ||
    (typeof founderBucket === 'string' && founderBucket.includes('ENTERPRISE')) ||
    (Array.isArray(venue.organization.tags) &&
      venue.organization.tags.includes(prospectGoodFitCriteria.excludedEnterpriseFlag))
  const categoryCandidates = [
    triage.normalizedType,
    venue.venueType,
    venue.organization.organizationType,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const category =
    categoryCandidates.find((candidate) =>
      rules.supportedCategories.some(
        (item) => item.toLowerCase() === candidate.trim().toLowerCase(),
      ),
    ) ?? categoryCandidates[0]
  const normalizedCategory = category?.trim().toLowerCase()
  const physicalIdentity = attributes.torchikoPhysicalIdentityV1
  const physical =
    physicalIdentity && typeof physicalIdentity === 'object'
      ? (physicalIdentity as Record<string, unknown>)
      : {}
  const isNonVenue = physical.state === 'NON_VENUE_HIGH_CONFIDENCE'
  const supported = Boolean(
    normalizedCategory &&
    rules.supportedCategories.some((item) => item.toLowerCase() === normalizedCategory),
  )
  const isStadiumClass =
    /stadium|arena/i.test(`${venue.name} ${venue.venueType ?? ''} ${category ?? ''}`) ||
    prospectCategorySizeRule(
      `${venue.organization.canonicalName} ${venue.name} ${category ?? ''}`,
    ) === 'XL'
  const inTerritory = territoryId
    ? venue.territoryId === territoryId || venue.organization.territoryId === territoryId
    : Boolean(venue.territoryId ?? venue.organization.territoryId)
  return {
    qualifies:
      supported &&
      qualifyingPriority &&
      (!rules.excludeEnterpriseDeferral || !enterpriseDeferred) &&
      (!rules.excludeNonVenue || !isNonVenue) &&
      (!(territoryId || rules.requireTerritory) || inTerritory) &&
      rules.sizeClasses.includes(size.sizeClass) &&
      (!rules.excludeStadiumArena || !isStadiumClass),
    reason: [
      supported
        ? `Supported category: ${category}.`
        : 'Category is not in the supported Good fit set.',
      founderBucket === rules.founderPriority
        ? `Founder priority is ${rules.founderPriority}.`
        : rules.buyerAttainabilityAnyOf.includes(String(buyerAttainability))
          ? 'Buyer attainability is medium or better.'
          : 'Founder priority or buyer attainability does not meet the Good fit rule.',
      size.reason,
      inTerritory
        ? 'Venue has an assigned territory.'
        : rules.requireTerritory
          ? 'No territory is assigned.'
          : 'Territory is optional in this view.',
    ].join(' '),
    unknown: size.unknown,
    excludedReason:
      rules.excludeStadiumArena && isStadiumClass
        ? 'Stadium or arena category is excluded.'
        : rules.excludeNonVenue && isNonVenue
          ? 'This record is confirmed as a non-venue.'
          : null,
  }
}
