/** Pure, clock-free market ranking. Never treat routing data as product-fit evidence. */
export const CHICAGO_RANKING_VERSION = 'chicago-venue-ranking/1.2.0' as const
export const CHICAGO_FIT_KEYS = [
  'knowledgeRichness',
  'recurringVisitorQuestions',
  'interpretiveValue',
  'physicalPlaceRelevance',
  'contentDepthStability',
  'guideUseCases',
] as const
export const CHICAGO_ATTAINABILITY_KEYS = [
  'organizationScale',
  'decisionPathSimplicity',
  'localControl',
  'relationshipState',
  'pilotScope',
] as const
export type ChicagoFitKey = (typeof CHICAGO_FIT_KEYS)[number]
export type ChicagoAttainabilityKey = (typeof CHICAGO_ATTAINABILITY_KEYS)[number]
export type ChicagoRankingState =
  | 'evidence-backed'
  | 'provisional-heuristic'
  | 'needs-research'
  | 'excluded'
  | 'intentionally-unranked'
export interface RankingObservation {
  value: number
  reason: string
  sourceUrls: string[]
  researchedAt?: string | null
  basis: 'verified' | 'heuristic'
}
export interface RankingSource {
  url: string
  firstParty: boolean | null
  researchedAt?: string | null
  conflicted?: boolean
}
export interface RankingContact {
  kind: 'email' | 'phone' | 'form' | 'website'
  verified: boolean
  suppressed: boolean
  roleRelevant: boolean | null
  sourceUrls: string[]
  researchedAt?: string | null
}
export interface ChicagoRankingOverride {
  actor: string
  at: string
  rationale: string
  dimension: 'productFit' | 'attainability' | 'contactability'
  value: number
}
export interface ChicagoRankingInput {
  venueId: string
  /** Explicit evaluation date makes source-age transitions reproducible. */
  asOf: string
  territory: string
  venueType?: string | null
  archived?: boolean
  exclusionReason?: string | null
  intentionallyUnrankedReason?: string | null
  fit?: Partial<Record<ChicagoFitKey, RankingObservation | null>>
  attainability?: Partial<Record<ChicagoAttainabilityKey, RankingObservation | null>>
  contacts?: RankingContact[]
  sources?: RankingSource[]
  /** Fixed expected fields, supplied by the adapter. Missing input uses the defaults below. */
  fields?: Record<string, boolean>
  conflicts?: string[]
  override?: ChicagoRankingOverride | null
}
export interface RankingComponent {
  key: string
  value: number | null
  reason: string
  sourceUrls: string[]
  basis: 'verified' | 'heuristic' | 'unknown' | 'derived'
  researchedAt: string | null
}
export interface RankingDimension {
  value: number | null
  /** Known component proportion; the score does not impute missing components as zero. */
  coverage: number
  components: RankingComponent[]
  reasons: string[]
  sourceUrls: string[]
}
export interface ChicagoVenueRanking {
  version: string
  venueId: string
  asOf: string
  state: ChicagoRankingState
  stateReason: string
  productFit: RankingDimension
  attainability: RankingDimension
  contactability: RankingDimension
  evidenceQuality: RankingDimension
  evidenceFreshness: RankingDimension
  completeness: RankingDimension
  researchPriority: RankingDimension
  researchGaps: Array<{ key: string; reason: string; priority: number }>
  uncertainty: string[]
  override: ChicagoRankingOverride | null
  /** Numeric nullable dimensions, not a blended score; ID breaks all final ties. */
  rankKey: [number | null, number | null, number | null, number | null]
}

const round = (n: number) => Math.round(n * 100) / 100
const unique = (values: string[]) => [...new Set(values)].sort()
function dateValue(date: string | null | undefined): number | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const value = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === date
    ? value
    : null
}
function urls(values: string[]): string[] {
  return unique(
    values.filter((value) => {
      try {
        const url = new URL(value)
        return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      } catch {
        return false
      }
    }),
  )
}
function validScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100
}
function freshness(date: string | null | undefined, asOf: number): number | null {
  const value = dateValue(date)
  if (value === null || value > asOf) return null
  const age = (asOf - value) / 86_400_000
  return age <= 90 ? 100 : age <= 180 ? 75 : age <= 365 ? 40 : 10
}
/** One vote per canonical page; raw observations remain append-only in the caller. */
function currentSources(observations: readonly RankingSource[], asOf: number): RankingSource[] {
  const groups = new Map<string, RankingSource[]>()
  for (const observation of observations) {
    if (!urls([observation.url]).length) continue
    const url = new URL(observation.url)
    url.hash = ''
    const key = url.toString()
    const group = groups.get(key) ?? []
    group.push(observation)
    groups.set(key, group)
  }
  return [...groups]
    .sort(([a], [b]) => compareText(a, b))
    .map(([url, observations]) => {
      const dated = observations.filter((source) => freshness(source.researchedAt, asOf) !== null)
      const latestDate = dated.reduce<string | null>(
        (latest, source) =>
          !latest || source.researchedAt! > latest ? source.researchedAt! : latest,
        null,
      )
      const current = latestDate
        ? dated.filter((source) => source.researchedAt === latestDate)
        : observations
      // Conflicting same-date ownership stays unknown; repetition never acts as a vote.
      const ownership = new Set(current.map((source) => source.firstParty))
      return {
        url,
        researchedAt: latestDate,
        firstParty: ownership.size === 1 ? current[0]!.firstParty : null,
        // A later duplicate is not an explicit resolution of an existing conflict.
        conflicted: observations.some((source) => source.conflicted === true),
      }
    })
}
function component(
  key: string,
  observation: RankingObservation | null | undefined,
  asOf: number,
): RankingComponent {
  const support = urls(observation?.sourceUrls ?? [])
  const valid =
    observation &&
    validScore(observation.value) &&
    observation.reason.trim() &&
    ['verified', 'heuristic'].includes(observation.basis) &&
    (observation.basis !== 'verified' || support.length > 0)
  return {
    key,
    value: valid ? observation.value : null,
    reason: valid ? observation.reason : `Unknown ${key}; no admissible scored evidence.`,
    sourceUrls: support,
    basis: valid ? observation.basis : 'unknown',
    researchedAt:
      freshness(observation?.researchedAt, asOf) !== null
        ? (observation?.researchedAt ?? null)
        : null,
  }
}
function derived(
  key: string,
  value: number | null,
  reason: string,
  sourceUrls: string[] = [],
): RankingComponent {
  return {
    key,
    value,
    reason,
    sourceUrls,
    basis: value === null ? 'unknown' : 'derived',
    researchedAt: null,
  }
}
function dimension(components: RankingComponent[]): RankingDimension {
  const known = components.filter((part) => part.value !== null)
  return {
    value: known.length
      ? round(known.reduce((sum, part) => sum + part.value!, 0) / known.length)
      : null,
    coverage: components.length ? round(known.length / components.length) : 0,
    components,
    reasons: components.map((part) => part.reason),
    sourceUrls: unique(components.flatMap((part) => part.sourceUrls)),
  }
}

/** Only a labeled category prior for plausible use cases; never facts about the venue. */
function categoryIssue(category: string | null | undefined): string | null {
  if (!category?.trim()) return 'Venue category is unknown; research the actual venue taxonomy.'
  if (category.length > 120)
    return 'Category exceeds 120 characters; source value retained, but no taxonomy prior is admissible until reviewed.'
  const label = category.replace(/_/g, ' ').trim()
  if (
    label.split(/\s+/).length > 12 ||
    [...label].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    /[<>{}=]/u.test(label) ||
    label.includes('[') ||
    label.includes(']') ||
    label.includes('://')
  )
    return 'Category contains prose or malformed label content; source value retained for taxonomy review.'
  if (/\b(?:not|no|unknown|uncertain|unverified|maybe|possibly|tbd|or)\b|\?/i.test(label))
    return 'Category is ambiguous, negated or uncertain; source value retained for taxonomy review.'
  return null
}
function categoryPrior(category: string | null | undefined): RankingObservation | undefined {
  if (categoryIssue(category) || !category) return undefined
  // Legacy taxonomy uses underscores as separators. Normalize only this comparison,
  // never the original value; word boundaries prevent notamuseum/parkour boosts.
  const label = category.replace(/_/g, ' ')
  const value =
    /\b(?:museums?|botanic(?:al)?|arboretums?|historic(?:al)?|heritage|science|aquariums?|zoos?|nature cent(?:er|re)s?)\b/i.test(
      label,
    )
      ? 80
      : /\b(?:gallery|galleries|gardens?|parks?|visitors?|cultural|library|libraries|tours?)\b/i.test(
            label,
          )
        ? 65
        : /\b(?:brewery|breweries|winery|wineries|distillery|distilleries|attractions?|farms?|retail|restaurants?|hotels?)\b/i.test(
              label,
            )
          ? 45
          : undefined
  if (value === undefined) return undefined
  return {
    value,
    reason: `Category prior (${category}) suggests possible guide use cases; verify the actual venue.`,
    sourceUrls: [],
    basis: 'heuristic',
  }
}

export function rankChicagoVenue(input: ChicagoRankingInput): ChicagoVenueRanking {
  const asOf = dateValue(input.asOf)
  if (asOf === null) throw new Error('Ranking requires a valid explicit YYYY-MM-DD asOf date')
  if (!input.venueId.trim()) throw new Error('Ranking requires a stable venueId')
  const fit = { ...input.fit }
  if (!fit.guideUseCases) fit.guideUseCases = categoryPrior(input.venueType) ?? null
  const productFit = dimension(CHICAGO_FIT_KEYS.map((key) => component(key, fit[key], asOf)))
  const attainability = dimension(
    CHICAGO_ATTAINABILITY_KEYS.map((key) => component(key, input.attainability?.[key], asOf)),
  )
  const contacts = input.contacts ?? []
  const usableContacts = contacts.filter(
    (contact) => contact.verified && !contact.suppressed && urls(contact.sourceUrls).length,
  )
  // No observed route is unknown, not proof that no public route exists.
  const contactParts = usableContacts.map((contact, index) => {
    const ageScore = freshness(contact.researchedAt, asOf)
    const role = contact.roleRelevant === true ? 100 : contact.roleRelevant === false ? 25 : null
    const base = contact.kind === 'website' ? 25 : contact.kind === 'form' ? 70 : 85
    return derived(
      `route:${index}:${contact.kind}`,
      round(
        base *
          (role === null ? 0.7 : 0.5 + role / 200) *
          (ageScore === null ? 0.5 : 0.5 + ageScore / 200),
      ),
      `${contact.kind}: verified public route; role ${role === null ? 'unknown' : contact.roleRelevant ? 'relevant' : 'not relevant'}; freshness ${ageScore === null ? 'unknown' : ageScore}.`,
      urls(contact.sourceUrls),
    )
  })
  const contactability = dimension(
    contactParts.length
      ? contactParts
      : [
          derived(
            'publicRoute',
            contacts.length && contacts.every((contact) => contact.suppressed) ? 0 : null,
            contacts.length && contacts.every((contact) => contact.suppressed)
              ? 'All recorded routes are suppressed; no contact action authorized.'
              : 'No verified, unsuppressed public route recorded; contactability is unknown.',
          ),
        ],
  )
  // A second low-quality route does not lower or increase the best available route.
  if (contactParts.length)
    contactability.value = Math.max(...contactParts.map((part) => part.value!))
  const sources = currentSources(input.sources ?? [], asOf)
  const evidenceQuality = dimension(
    sources.map((source) =>
      derived(
        source.url,
        source.conflicted
          ? 0
          : source.firstParty === true
            ? 100
            : source.firstParty === false
              ? 40
              : null,
        source.conflicted
          ? 'Source has an unresolved conflict.'
          : source.firstParty === null
            ? 'Source ownership is unknown.'
            : source.firstParty
              ? 'First-party support recorded.'
              : 'Secondary source only.',
        [source.url],
      ),
    ),
  )
  const evidenceFreshness = dimension(
    sources.map((source) =>
      derived(
        source.url,
        freshness(source.researchedAt, asOf),
        freshness(source.researchedAt, asOf) === null
          ? 'Research date absent, invalid, or in the future.'
          : `Research date ${source.researchedAt}.`,
        [source.url],
      ),
    ),
  )
  const fields = input.fields ?? {
    venueType: Boolean(input.venueType),
    fit: productFit.coverage === 1,
    attainability: attainability.coverage === 1,
    publicRoute: usableContacts.length > 0,
    sources: sources.length > 0,
    researchDate: evidenceFreshness.coverage === 1 && sources.length > 0,
  }
  const completeness = dimension(
    Object.keys(fields)
      .sort()
      .map((key) =>
        derived(key, fields[key] ? 100 : 0, fields[key] ? `${key} recorded.` : `${key} missing.`),
      ),
  )
  const conflicts = unique([
    ...(input.conflicts ?? []),
    ...sources
      .filter((source) => source.conflicted)
      .map((source) => `Conflicted source: ${source.url}`),
  ])
  const researchGaps: ChicagoVenueRanking['researchGaps'] = []
  const taxonomyIssue = categoryIssue(input.venueType)
  if (taxonomyIssue) researchGaps.push({ key: 'venueType', reason: taxonomyIssue, priority: 90 })
  else if (!categoryPrior(input.venueType))
    researchGaps.push({
      key: 'venueType',
      reason:
        'Category has no recognized taxonomy prior; research guide use cases directly rather than inferring fit from a substring.',
      priority: 80,
    })
  for (const part of [...productFit.components, ...attainability.components]) {
    if (part.value === null)
      researchGaps.push({
        key: part.key,
        reason: part.reason,
        priority: CHICAGO_FIT_KEYS.includes(part.key as ChicagoFitKey) ? 100 : 70,
      })
    else if (part.basis === 'heuristic')
      researchGaps.push({
        key: part.key,
        reason: 'Replace category or other heuristic with source-backed venue evidence.',
        priority: 95,
      })
    else if (
      freshness(part.researchedAt, asOf) === null ||
      freshness(part.researchedAt, asOf)! < 75
    )
      researchGaps.push({
        key: part.key,
        reason: 'Refresh missing or stale evidence date.',
        priority: 85,
      })
  }
  if (!usableContacts.length)
    researchGaps.push({
      key: 'publicRoute',
      reason: 'Find a verified public routing option; do not infer a private contact.',
      priority: 60,
    })
  if (evidenceQuality.value === null || evidenceQuality.value < 100)
    researchGaps.push({
      key: 'firstPartySources',
      reason: 'Verify first-party support and resolve source ownership.',
      priority: 90,
    })
  if (evidenceFreshness.value === null || evidenceFreshness.value < 75)
    researchGaps.push({
      key: 'evidenceFreshness',
      reason: 'Refresh absent, undated, or stale source evidence.',
      priority: 85,
    })
  for (const conflict of conflicts)
    researchGaps.push({ key: 'conflict', reason: conflict, priority: 100 })
  researchGaps.sort(
    (a, b) =>
      b.priority - a.priority || compareText(a.key, b.key) || compareText(a.reason, b.reason),
  )
  const researchPriority = dimension([
    derived(
      'fitUncertainty',
      round(
        (100 *
          productFit.components.filter((part) => part.value === null || part.basis !== 'verified')
            .length) /
          CHICAGO_FIT_KEYS.length,
      ),
      'Share of product-fit components missing or heuristic; research can change these conclusions.',
    ),
    derived(
      'missingData',
      completeness.value === null ? null : 100 - completeness.value,
      'Share of expected data fields missing; does not change fit.',
    ),
    derived(
      'staleness',
      evidenceFreshness.value === null ? 100 : 100 - evidenceFreshness.value,
      'Unknown evidence dates receive maximum refresh priority, not a zero evidence score.',
    ),
  ])
  if (conflicts.length) researchPriority.value = 100
  const uncertainty = unique([
    ...researchGaps.map((gap) => gap.reason),
    ...usableContacts
      .filter((contact) => contact.roleRelevant === null)
      .map(() => 'Contact role relevance is unknown.'),
    ...usableContacts
      .filter((contact) => freshness(contact.researchedAt, asOf) === null)
      .map(() => 'Public contact source freshness is unknown.'),
  ])
  let state: ChicagoRankingState =
    productFit.value === null ? 'needs-research' : 'provisional-heuristic'
  let stateReason =
    productFit.value === null
      ? 'No product-fit evidence or recognized category prior.'
      : 'Partial, heuristic, stale, or conflicted evidence; inspect component coverage.'
  if (
    productFit.components.every(
      (part) =>
        part.basis === 'verified' &&
        freshness(part.researchedAt, asOf) !== null &&
        freshness(part.researchedAt, asOf)! >= 75,
    ) &&
    !conflicts.length
  ) {
    state = 'evidence-backed'
    stateReason =
      'All six product-fit components have dated, supported observations within 180 days; other dimensions may remain incomplete.'
  }
  if (input.intentionallyUnrankedReason?.trim()) {
    state = 'intentionally-unranked'
    stateReason = input.intentionallyUnrankedReason
  }
  if (input.territory !== 'Chicago Metro' || input.archived || input.exclusionReason?.trim()) {
    state = 'excluded'
    stateReason =
      input.exclusionReason?.trim() ||
      (input.archived
        ? 'Archived venue.'
        : 'Outside the established Chicago Metro operating territory.')
  }
  const override = input.override ?? null
  if (override) {
    const overrideDate = dateValue(override.at.slice(0, 10))
    if (
      !['productFit', 'attainability', 'contactability'].includes(override.dimension) ||
      !override.actor.trim() ||
      !override.rationale.trim() ||
      overrideDate === null ||
      overrideDate > asOf ||
      !validScore(override.value)
    )
      throw new Error(
        'Override requires a valid dimension, actor, nonfuture date, rationale, and score from 0 to 100',
      )
    const target = { productFit, attainability, contactability }[override.dimension]
    target.reasons.push(
      `Human override by ${override.actor} at ${override.at}: ${override.rationale}; computed value ${target.value ?? 'unknown'} retained in components.`,
    )
    target.value = override.value
    uncertainty.push('Human override is a decision, not new research evidence.')
    if (state === 'needs-research' && override.dimension === 'productFit') {
      state = 'provisional-heuristic'
      stateReason = 'Human fit override with incomplete underlying evidence.'
    }
  }
  return {
    version: CHICAGO_RANKING_VERSION,
    venueId: input.venueId,
    asOf: input.asOf,
    state,
    stateReason,
    productFit,
    attainability,
    contactability,
    evidenceQuality,
    evidenceFreshness,
    completeness,
    researchPriority,
    researchGaps,
    uncertainty: unique(uncertainty),
    override,
    rankKey:
      state === 'excluded' || state === 'intentionally-unranked'
        ? [null, null, null, null]
        : [productFit.value, attainability.value, evidenceQuality.value, contactability.value],
  }
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
/** Known fit first, then opportunity, evidence, routing. Null remains null in all data. */
export function compareChicagoVenueRankings(
  a: ChicagoVenueRanking,
  b: ChicagoVenueRanking,
): number {
  const inactive = (value: ChicagoVenueRanking) =>
    value.state === 'excluded' || value.state === 'intentionally-unranked'
  if (inactive(a) !== inactive(b)) return inactive(a) ? 1 : -1
  for (let index = 0; index < a.rankKey.length; index++) {
    const av = a.rankKey[index] ?? null
    const bv = b.rankKey[index] ?? null
    if (av === bv) continue
    if (av === null) return 1
    if (bv === null) return -1
    return bv - av
  }
  return compareText(a.venueId, b.venueId)
}
/** Compare retained snapshots, including old versions, without relabeling historical scores. */
export function compareChicagoRankingVersions(
  before: ChicagoVenueRanking,
  after: ChicagoVenueRanking,
) {
  if (before.venueId !== after.venueId)
    throw new Error('Ranking comparison requires the same venue')
  const keys = [
    'productFit',
    'attainability',
    'contactability',
    'evidenceQuality',
    'evidenceFreshness',
    'completeness',
    'researchPriority',
  ] as const
  return {
    venueId: before.venueId,
    beforeVersion: before.version,
    afterVersion: after.version,
    beforeAsOf: before.asOf,
    afterAsOf: after.asOf,
    stateChanged: before.state !== after.state,
    dimensions: Object.fromEntries(
      keys.map((key) => [
        key,
        {
          before: before[key].value,
          after: after[key].value,
          delta:
            before[key].value === null || after[key].value === null
              ? null
              : round(after[key].value! - before[key].value!),
        },
      ]),
    ),
  }
}
