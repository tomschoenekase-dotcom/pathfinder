import { z } from 'zod'

export const prospectSizeClassSchema = z.enum(['XS', 'S', 'M', 'L', 'XL', 'UNKNOWN'])
export type ProspectSizeClass = z.infer<typeof prospectSizeClassSchema>

export const prospectSizeBasisSchema = z.enum([
  'seats',
  'capacity',
  'square_feet',
  'acres',
  'annual_attendance',
  'category_rule',
  'unknown',
])
export type ProspectSizeBasis = z.infer<typeof prospectSizeBasisSchema>

export const prospectSizeConfidenceSchema = z.enum(['measured', 'structured', 'rule'])

export const prospectSizeUnits = {
  seats: 'seats',
  capacity: 'people',
  square_feet: 'square_feet',
  acres: 'acres',
  annual_attendance: 'visitors/year',
} as const

export const prospectSizeEvidenceSchema = z
  .object({
    class: prospectSizeClassSchema,
    basis: prospectSizeBasisSchema,
    value: z.number().finite().positive().optional(),
    unit: z.string().trim().min(1).max(40).optional(),
    sourceUrl: z.string().url().max(2000).optional(),
    observedAt: z.string().date(),
    confidence: prospectSizeConfidenceSchema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.class === 'UNKNOWN') {
      if (
        evidence.basis !== 'unknown' ||
        evidence.confidence !== undefined ||
        evidence.value !== undefined ||
        evidence.unit !== undefined ||
        evidence.sourceUrl !== undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'UNKNOWN evidence must use basis unknown without confidence or measured fields',
        })
      }
      return
    }
    if (evidence.confidence === 'measured' || evidence.confidence === 'structured') {
      if (evidence.basis === 'category_rule' || evidence.basis === 'unknown') {
        context.addIssue({
          code: 'custom',
          message: 'Numeric evidence needs a numeric size class and basis',
        })
      }
      if (
        evidence.value === undefined ||
        evidence.unit === undefined ||
        evidence.sourceUrl === undefined
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Numeric evidence needs value, unit, and sourceUrl',
        })
      }
      if (
        evidence.confidence === 'structured' &&
        !/^https:\/\/(?:www\.)?(?:wikidata\.org\/wiki\/Q[1-9]\d*|openstreetmap\.org\/(?:node|way|relation)\/[1-9]\d*)$/.test(
          evidence.sourceUrl ?? '',
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Structured evidence needs a Wikidata item or OSM element URL',
        })
      }
      if (evidence.value !== undefined && evidence.basis in prospectSizeThresholds) {
        const expected = classifyProspectSize(
          evidence.value,
          evidence.basis as ProspectMeasuredSizeBasis,
        )
        if (evidence.class !== expected) {
          context.addIssue({
            code: 'custom',
            message: `Numeric value class does not match its threshold (expected ${expected})`,
          })
        }
      }
      if (
        evidence.basis in prospectSizeUnits &&
        evidence.unit !== prospectSizeUnits[evidence.basis as keyof typeof prospectSizeUnits]
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Numeric evidence unit must match its basis',
        })
      }
    } else if (
      evidence.confidence === 'rule' &&
      (evidence.basis !== 'category_rule' ||
        evidence.value !== undefined ||
        evidence.unit !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Rule evidence must use category_rule without a measured value or unit',
      })
    } else if (
      evidence.confidence === undefined ||
      evidence.basis !== 'category_rule' ||
      evidence.value !== undefined ||
      evidence.unit !== undefined
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Known rule evidence needs confidence rule and category_rule basis',
      })
    }
    if (evidence.confidence === 'rule' && evidence.sourceUrl === undefined) {
      context.addIssue({ code: 'custom', message: 'Rule evidence needs a sourceUrl' })
    }
  })
export type ProspectSizeEvidence = z.infer<typeof prospectSizeEvidenceSchema>

// Seat and attendance bands are proposed in Packet 7. Building area and outdoor acreage bands are provisional pending Tom's review.
export const prospectSizeThresholds = {
  seats: [100, 500, 3_000, 10_000],
  capacity: [100, 500, 3_000, 10_000],
  annual_attendance: [10_000, 50_000, 250_000, 1_000_000],
  square_feet: [2_000, 10_000, 50_000, 200_000],
  acres: [1, 10, 100, 1_000],
} as const

export type ProspectMeasuredSizeBasis = keyof typeof prospectSizeThresholds

export function classifyProspectSize(
  value: number,
  basis: ProspectMeasuredSizeBasis,
): Exclude<ProspectSizeClass, 'UNKNOWN'> {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError('Size value must be a positive finite number')
  const [xs, small, medium, large] = prospectSizeThresholds[basis]
  if (value < xs) return 'XS'
  if (value < small) return 'S'
  if (value < medium) return 'M'
  if (value < large) return 'L'
  return 'XL'
}

export const prospectSizeProposalRecordSchema = z
  .object({
    venueId: z.string().min(1).max(191),
    organizationId: z.string().min(1).max(191).nullable(),
    snapshotName: z.string().min(1).max(300),
    snapshotCity: z.string().max(200).nullable(),
    snapshotRegion: z.string().max(100).nullable(),
    expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
    size: prospectSizeEvidenceSchema,
  })
  .strict()

export const prospectSizeProposalFileSchema = z
  .object({
    schema: z.literal('torchiko.prospect-size-proposals/v1'),
    status: z.literal('proposal-only'),
    records: z.array(prospectSizeProposalRecordSchema).min(1).max(500),
  })
  .strict()
  .superRefine((file, context) => {
    const venueIds = new Set<string>()
    for (const [index, record] of file.records.entries()) {
      if (venueIds.has(record.venueId)) {
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'venueId'],
          message: 'venueId must be unique within a proposal file',
        })
      }
      venueIds.add(record.venueId)
    }
  })

export const parseProspectSizeProposalFile = (input: unknown) =>
  prospectSizeProposalFileSchema.parse(input)

export const prospectGoodFitCriteria = {
  supportedCategories: [
    'stadium_sports_venue',
    'attraction_immersive',
    'zoo_aquarium_animal',
    'farm_orchard_agritourism',
    'garden_conservatory_arboretum',
    'recreation',
    'museum',
    'historic_site',
    'nature_center',
    'park_nature_preserve',
    'motorsports',
    'visitor_center',
    'cultural_center',
    'art_gallery',
    'theater_performing_arts',
    'historical society',
    'nature center',
    'aquarium',
    'zoo',
    'botanical garden',
    'garden',
    'science center',
    'cultural center',
    "children's museum",
    'historic house',
    'family entertainment',
    'zoo_aquarium',
    'botanical_garden',
    'performing_arts',
  ],
  eligibleSizeClasses: ['S', 'M', 'L'] as const,
  preferredSizeClass: 'M' as const,
  founderPriority: 'MID_TIER_PRIORITY' as const,
  minimumBuyerAttainability: 'BUYER_MEDIUM_ATTAINABLE' as const,
  buyerAttainabilityAnyOf: ['BUYER_SMALL_ATTAINABLE', 'BUYER_MEDIUM_ATTAINABLE'] as const,
  excludedEnterpriseFlag: 'enterprise-deferral',
  blockedDuplicateStatuses: ['OPEN', 'CONFIRMED_DUPLICATE'] as const,
  noOutboundOrCampaignHistory: true,
} as const

// A saved view owns these switches. The built-in view supplies the conservative
// defaults; an administrator can save a named variation without changing them
// for the assistant or other users.
export const prospectGoodFitRulesSchema = z
  .object({
    supportedCategories: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    sizeClasses: z.array(prospectSizeClassSchema).min(1).max(6),
    preferredSizeClass: prospectSizeClassSchema,
    founderPriority: z.string().trim().min(1).max(100),
    buyerAttainabilityAnyOf: z.array(z.string().trim().min(1).max(100)).max(5),
    requireTerritory: z.boolean(),
    excludeEnterpriseDeferral: z.boolean(),
    excludeOutboundCorrespondence: z.boolean(),
    excludeCampaignMembership: z.boolean(),
    excludeDrafts: z.boolean(),
    excludeOpenOrConfirmedDuplicates: z.boolean(),
    excludeStadiumArena: z.boolean(),
    excludeNonVenue: z.boolean(),
  })
  .strict()
  .refine((rules) => rules.sizeClasses.includes(rules.preferredSizeClass), {
    message: 'Preferred size must be included in this view',
    path: ['preferredSizeClass'],
  })
export type ProspectGoodFitRules = z.infer<typeof prospectGoodFitRulesSchema>

export const defaultProspectGoodFitRules: ProspectGoodFitRules = {
  supportedCategories: [...prospectGoodFitCriteria.supportedCategories],
  sizeClasses: [...prospectGoodFitCriteria.eligibleSizeClasses],
  preferredSizeClass: prospectGoodFitCriteria.preferredSizeClass,
  founderPriority: prospectGoodFitCriteria.founderPriority,
  buyerAttainabilityAnyOf: [...prospectGoodFitCriteria.buyerAttainabilityAnyOf],
  requireTerritory: true,
  excludeEnterpriseDeferral: true,
  excludeOutboundCorrespondence: true,
  excludeCampaignMembership: true,
  excludeDrafts: true,
  excludeOpenOrConfirmedDuplicates: true,
  excludeStadiumArena: true,
  excludeNonVenue: true,
}

const categoryRuleExamples: Record<string, ProspectSizeClass> = {
  'professional stadium': 'XL',
  'professional arena': 'XL',
  'pro stadium': 'XL',
  'pro arena': 'XL',
  'major league stadium': 'XL',
  'major league arena': 'XL',
  'national museum': 'XL',
  'flagship museum': 'XL',
  'major destination attraction': 'XL',
  skydeck: 'XL',
  'navy pier': 'XL',
  'major theme park': 'XL',
  'major water park': 'XL',
  'minor league ballpark': 'L',
  'major league ballpark': 'XL',
  'regional zoo': 'L',
  'regional aquarium': 'L',
  'metro science museum': 'L',
  'metro art museum': 'L',
  'large theme park': 'L',
  'large water park': 'L',
  'escape room': 'M',
  'trampoline park': 'M',
  'bowling alley': 'M',
  bowling: 'M',
  'family entertainment center': 'M',
  'community ice complex': 'M',
  'community sports complex': 'M',
  'historical society': 'S',
  'small historical society': 'S',
  'house museum': 'S',
  'historic house museum': 'S',
  'nature center': 'S',
  'miniature museum': 'S',
  'single collection museum': 'S',
  'single-collection museum': 'S',
  'small gallery': 'S',
}

export function prospectCategorySizeRule(
  category: string | null | undefined,
): ProspectSizeClass | undefined {
  if (!category) return undefined
  const normalized = category.trim().toLowerCase().replace(/\s+/g, ' ')
  if (
    /(stadium|arena)/.test(normalized) &&
    /(nfl|mlb|nba|nhl|major league|professional)/.test(normalized)
  )
    return 'XL'
  if (
    /chicago bears|soldier field|nfl/.test(normalized) &&
    /(venue|stadium|arena|football|bears)/.test(normalized)
  )
    return 'XL'
  return categoryRuleExamples[normalized]
}

export function explainProspectSize(evidence: unknown): {
  sizeClass: ProspectSizeClass
  reason: string
  unknown: string | null
} {
  const nestedEvidence =
    evidence && typeof evidence === 'object' && 'torchikoSizeV1' in evidence
      ? (evidence as { torchikoSizeV1: unknown }).torchikoSizeV1
      : evidence
  const parsed = prospectSizeEvidenceSchema.safeParse(nestedEvidence)
  if (!parsed.success)
    return {
      sizeClass: 'UNKNOWN',
      reason: 'No validated size evidence is stored.',
      unknown: 'Venue size has not been established.',
    }
  const size = parsed.data
  return {
    sizeClass: size.class,
    reason:
      size.class === 'UNKNOWN'
        ? 'Size evidence is pending and currently UNKNOWN.'
        : size.confidence === 'measured'
          ? `Official ${size.basis.replaceAll('_', ' ')} evidence: ${size.value} ${size.unit}.`
          : size.confidence === 'structured'
            ? size.sourceUrl?.includes('openstreetmap.org')
              ? `Mapped OSM ${size.basis === 'acres' ? 'site polygon area' : 'building polygon footprint'}: ${size.value} ${size.unit}.`
              : `Structured public ${size.basis.replaceAll('_', ' ')} evidence: ${size.value} ${size.unit}.`
            : `Category rule classified this venue as ${size.class}.`,
    unknown: size.class === 'UNKNOWN' ? 'Venue size has not been established.' : null,
  }
}
