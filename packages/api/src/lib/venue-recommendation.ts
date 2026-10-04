/**
 * Pure venue-recommendation eligibility and ranking. No database, no model calls, no clock reads:
 * every input is explicit so each rule is unit-testable.
 *
 * Order of decisions:
 *   1. Capability gate (policy row, enabled, unexpired).
 *   2. Hard eligibility per item: venue, freshness, availability, hours/season, and the guest's
 *      own stated budget / dietary / allergy constraints. Unknown allergens are never safe.
 *   3. Relevance of the request. Safety, accessibility, directions and unrelated questions never
 *      attract an unsolicited suggestion.
 *   4. Usefulness ranking, then a bounded commercial tie-break (at most `maxBoost` points on a
 *      0-100 usefulness scale, HIGH-priority items only).
 *   5. Session limits: honoured refusal and the unsolicited-per-session cap.
 *
 * A direct question that names an item is always answered with its truthful facts, whatever the
 * session state, and never counts as a recommendation.
 *
 * The commercial priority enters only through `priorities`, is consumed here, and is never copied
 * into the returned decision.
 */

export type CatalogCategory = 'cold_drink' | 'hot_drink' | 'snack' | 'meal' | 'other'
export type CatalogAvailabilityState = 'AVAILABLE' | 'UNAVAILABLE' | 'UNKNOWN'
export type CommercialPriority = 'LOW' | 'NORMAL' | 'HIGH'
export type DietaryState = 'yes' | 'no' | 'unknown'

/** `unknown` is deliberately distinct from `known` with an empty list ("none"). */
export type VerifiedList = { status: 'known' | 'unknown'; values: string[] }

export type CatalogHours = {
  timeZone: string
  windows: Array<{ days: number[]; open: string; close: string }>
}

/** Guest-safe facts only. The commercial priority is intentionally not a field of this type. */
export type CatalogItemFacts = {
  id: string
  venueId: string
  version: number
  category: CatalogCategory
  name: string
  description: string | null
  placeId: string | null
  routeNote: string | null
  priceMinor: number | null
  currency: string | null
  sizeLabel: string | null
  priceObservedAt: Date | null
  effectiveFrom: Date | null
  effectiveUntil: Date | null
  availability: CatalogAvailabilityState
  availabilityObservedAt: Date | null
  hours: CatalogHours | null
  seasonalWindows: Array<{ start: string; end: string }>
  ingredients: VerifiedList
  allergens: VerifiedList
  dietary: Record<string, DietaryState>
  lastVerifiedAt: Date | null
  allowedClaims: string[]
  archived: boolean
}

export type RecommendationPolicyFacts = {
  id: string
  venueId: string
  version: number
  enabled: boolean
  maxBoost: number
  maxUnsolicitedPerSession: number
  factMaxAgeDays: number
  availabilityMaxAgeHours: number
  expiresAt: Date | null
}

export type RecommendationSessionState = {
  unsolicitedShown: number
  shownItemIds: string[]
  declined: boolean
}

export type GuestConstraints = {
  maxPriceMinor: number | null
  cheapest: boolean
  allergens: string[]
  dietary: string[]
}

export type RequestIntent = 'refreshment' | 'blocked' | 'other'

export type ExclusionReason =
  | 'venue_mismatch'
  | 'archived'
  | 'not_effective'
  | 'facts_unverified'
  | 'facts_stale'
  | 'price_unknown'
  | 'price_stale'
  | 'availability_unknown'
  | 'availability_stale'
  | 'unavailable'
  | 'closed'
  | 'out_of_season'
  | 'over_budget'
  | 'allergen_conflict'
  | 'allergens_unknown'
  | 'dietary_unverified'
  | 'not_relevant_category'
  | 'already_shown'

export type NoShowReason =
  | 'policy_venue_mismatch'
  | 'policy_expired'
  | 'direct_question'
  | 'blocked_topic'
  | 'not_relevant'
  | 'declined_this_session'
  | 'repetition_cap'
  | 'no_eligible_candidate'
  | 'no_competitive_featured_item'

export type ItemSummary = {
  itemId: string
  itemVersion: number
  name: string
  description: string | null
  priceText: string | null
  sizeLabel: string | null
  routeText: string | null
  allowedClaims: string[]
}

export type DirectItemFacts = ItemSummary & {
  availabilityText: string
  hoursText: string | null
  allergenText: string
  ingredientText: string
  eligibleNow: boolean
  exclusionReasons: ExclusionReason[]
}

export type RecommendationDecision = {
  /** `promoted` = one featured item may be mentioned; `direct` = answer about a named item. */
  mode: 'none' | 'promoted' | 'direct'
  policyId: string
  policyVersion: number
  intent: RequestIntent
  shown: ItemSummary | null
  alternatives: ItemSummary[]
  candidateIds: string[]
  exclusions: Array<{ itemId: string; name: string; reasons: ExclusionReason[] }>
  noShowReason: NoShowReason | null
  direct: DirectItemFacts[]
  /** Exact disclosure text, present only when mode is `promoted`. */
  disclosure: string | null
  /** True when the commercial tie-break (not usefulness alone) selected the shown item. */
  tieBreakDecided: boolean
  declinedNow: boolean
}

export const DEFAULT_MAX_UNSOLICITED_PER_SESSION = 1
export const MAX_ALTERNATIVES = 3

const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000

// ---------------------------------------------------------------------------------------------
// Text understanding (conservative, deterministic).
// ---------------------------------------------------------------------------------------------

const SAFETY_OR_ACCESS =
  /\b(emergenc(?:y|ies)|safety|unsafe|first[- ]aid|medical|injur(?:y|ed)|lost (?:child|kid)|missing (?:child|kid)|evacuat\w*|fire alarm|accessib\w*|wheelchair|step[- ]free|elevator|ramp|hearing loop|sensory|mobility)\b/iu
const DIRECTIONS_OR_HISTORY =
  /\b(directions?|how (?:do|can|should) i (?:get|go|find)|where (?:is|are|can i find)|nearest|route to|navigate|history|histor(?:ic|ical)|who (?:painted|made|built|designed|sculpted|created|carved)|when was|artist|sculptor|architect|exhibit|sculpture|painting)\b/iu
const STRONG_REFRESHMENT =
  /\b(thirst(?:y|iest)?|parched|drinks?|beverages?|refresh(?:ing|ment|ments)?|something (?:cold|cool|to drink)|cold (?:drink|one|beverage)|iced|cool (?:off|down)|chilled|(?:i'?m|i am|so|too|really) (?:hot|overheated|boiling))\b/iu
const WEAK_REFRESHMENT = /\b(caf[eé]|coffee|tea|juice|soda|lemonade)\b/iu
const WANTS_COLD = /\b(cold|iced|cool|chilled|refresh\w*|thirst\w*|hot out|so hot|too hot)\b/iu
const WANTS_HOT = /\b(hot (?:drink|coffee|tea|chocolate)|coffee|tea|warm up|warm drink)\b/iu

export function classifyRequestIntent(message: string): RequestIntent {
  const text = message.normalize('NFKC')
  const strong = STRONG_REFRESHMENT.test(text)
  const weak = WEAK_REFRESHMENT.test(text)
  if (SAFETY_OR_ACCESS.test(text)) return 'blocked'
  if (!strong && !weak) return 'other'
  // Directions or history framing wins unless the guest is clearly seeking something to drink.
  if (!strong && DIRECTIONS_OR_HISTORY.test(text)) return 'blocked'
  if (strong && /\b(exhibit|sculpture|painting|who (?:painted|made|built|designed))\b/iu.test(text))
    return /\b(thirst|drink|cold|refresh)/iu.test(text) ? 'refreshment' : 'blocked'
  return 'refreshment'
}

const DECLINE_PATTERNS = [
  /\bno,? thanks?\b/iu,
  /\bno thank you\b/iu,
  /\bnot (?:interested|really|today|now|for me)\b/iu,
  /\b(?:i'?m|i am) (?:good|fine|all set)\b/iu,
  /\b(?:don'?t|do not|stop|quit) (?:recommend|suggest|offer|pitch|push|upsell|promot)\w*/iu,
  /\bno (?:more )?(?:recommendations?|suggestions?|upsell\w*)\b/iu,
  /\bjust (?:answer|tell me)\b/iu,
]

export function isRecommendationDecline(message: string): boolean {
  const text = message.normalize('NFKC')
  return DECLINE_PATTERNS.some((pattern) => pattern.test(text))
}

const ALLERGEN_WORDS: Array<[RegExp, string[]]> = [
  [/\bpeanuts?\b/iu, ['peanut']],
  [
    /\b(?:tree[- ]?nuts?|almonds?|cashews?|walnuts?|pecans?|hazelnuts?|pistachios?|macadamias?)\b/iu,
    ['tree_nut'],
  ],
  [/(?<!tree[- ]?)\bnuts?\b/iu, ['peanut', 'tree_nut']],
  [/\b(?:milk|dairy|lactose|cream|cheese|butter|whey)\b/iu, ['milk']],
  [/\b(?:gluten|wheat|barley|rye|celiac|coeliac)\b/iu, ['gluten']],
  [/\bsoy|soya\b/iu, ['soy']],
  [/\beggs?\b/iu, ['egg']],
  [/\b(?:shellfish|shrimp|prawns?|crab|lobster)\b/iu, ['shellfish']],
  [/\bfish\b/iu, ['fish']],
  [/\bsesame\b/iu, ['sesame']],
  [/\b(?:sulfites?|sulphites?)\b/iu, ['sulfite']],
]

/** Canonical allergen keys mentioned by free text (either a guest message or a catalog value). */
export function allergenKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const [pattern, mapped] of ALLERGEN_WORDS) {
    if (pattern.test(text)) for (const key of mapped) keys.add(key)
  }
  return keys
}

const ALLERGY_CUE =
  /\b(allerg\w*|intoleran\w*|anaphyla\w*|can'?t (?:have|eat|drink)|cannot (?:have|eat|drink)|avoid(?:ing)?|sensitive to|celiac|coeliac)\b/iu

const DIETARY_WORDS: Array<[RegExp, string]> = [
  [/\bvegan\b/iu, 'vegan'],
  [/\bvegetarian\b/iu, 'vegetarian'],
  [/\bgluten[- ]free\b/iu, 'gluten_free'],
  [/\b(?:dairy|lactose)[- ]free\b/iu, 'dairy_free'],
  [/\bnut[- ]free\b/iu, 'nut_free'],
  [/\bsugar[- ]free\b/iu, 'sugar_free'],
  [/\bhalal\b/iu, 'halal'],
  [/\bkosher\b/iu, 'kosher'],
]

const CHEAPEST =
  /\b(cheap(?:est)?|least expensive|lowest[- ]priced?|most affordable|lowest price|budget[- ]friendly)\b/iu
const BUDGET_PATTERNS = [
  /\b(?:under|below|less than|max(?:imum)?|up to|at most|no more than|within|around)\s*\$?\s*(\d+(?:\.\d{1,2})?)/iu,
  /\$\s*(\d+(?:\.\d{1,2})?)\s*(?:or (?:less|under)|max(?:imum)?|tops|limit)/iu,
  /\b(?:budget|only have|have only|got only)\s*(?:of|is)?\s*\$?\s*(\d+(?:\.\d{1,2})?)/iu,
]

/**
 * Allergies and dietary needs persist across the supplied session messages (oldest first); the
 * budget and a cheapest request come only from the latest message so a changed mind is honoured.
 */
export function parseGuestConstraints(messagesOldestFirst: readonly string[]): GuestConstraints {
  const allergens = new Set<string>()
  const dietary = new Set<string>()
  for (const raw of messagesOldestFirst) {
    const text = raw.normalize('NFKC')
    if (ALLERGY_CUE.test(text)) {
      const keys = allergenKeys(text)
      if (keys.size === 0) allergens.add('unspecified')
      for (const key of keys) allergens.add(key)
    }
    for (const [pattern, flag] of DIETARY_WORDS) {
      if (pattern.test(text)) dietary.add(flag)
    }
  }
  const latest = (messagesOldestFirst.at(-1) ?? '').normalize('NFKC')
  let maxPriceMinor: number | null = null
  for (const pattern of BUDGET_PATTERNS) {
    const match = latest.match(pattern)
    if (match?.[1]) {
      maxPriceMinor = Math.round(Number(match[1]) * 100)
      break
    }
  }
  return {
    maxPriceMinor,
    cheapest: CHEAPEST.test(latest),
    allergens: [...allergens].sort(),
    dietary: [...dietary].sort(),
  }
}

const NAME_STOPWORDS = new Set([
  'fresh',
  'cold',
  'iced',
  'hot',
  'large',
  'small',
  'medium',
  'bottled',
  'bottle',
  'house',
  'classic',
  'original',
  'with',
  'and',
  'the',
  'drink',
])

function words(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
}

/** True when the text names the item (every distinctive token of its name appears as a word). */
export function mentionsItem(text: string, itemName: string): boolean {
  const tokens = words(itemName).filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token))
  if (tokens.length === 0) return false
  const present = new Set(words(text).flatMap((word) => [word, word.replace(/s$/u, '')]))
  return tokens.every((token) => present.has(token) || present.has(token.replace(/s$/u, '')))
}

// ---------------------------------------------------------------------------------------------
// Time windows.
// ---------------------------------------------------------------------------------------------

function localParts(
  now: Date,
  timeZone: string,
): { weekday: number; minutes: number; monthDay: string } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    month: '2-digit',
    day: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(formatter.formatToParts(now).map((p) => [p.type, p.value]))
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return {
    weekday: weekdays.indexOf(String(parts.weekday)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    monthDay: `${parts.month}-${parts.day}`,
  }
}

function toMinutes(hhmm: string): number {
  const [hours, minutes] = hhmm.split(':')
  return Number(hours) * 60 + Number(minutes)
}

function safeLocalParts(now: Date, timeZone: string) {
  try {
    return localParts(now, timeZone)
  } catch {
    return null
  }
}

function isOpenNow(hours: CatalogHours, now: Date): boolean {
  const local = safeLocalParts(now, hours.timeZone)
  // An unreadable time zone is not evidence of being open.
  if (!local) return false
  return hours.windows.some(
    (window) =>
      window.days.includes(local.weekday) &&
      local.minutes >= toMinutes(window.open) &&
      local.minutes < toMinutes(window.close),
  )
}

function isInSeason(item: CatalogItemFacts, now: Date): boolean {
  if (item.seasonalWindows.length === 0) return true
  const local = safeLocalParts(now, item.hours?.timeZone ?? 'UTC')
  if (!local) return false
  return item.seasonalWindows.some(({ start, end }) =>
    start <= end
      ? local.monthDay >= start && local.monthDay <= end
      : local.monthDay >= start || local.monthDay <= end,
  )
}

// ---------------------------------------------------------------------------------------------
// Eligibility.
// ---------------------------------------------------------------------------------------------

function age(now: Date, observed: Date): number {
  return now.getTime() - observed.getTime()
}

export function hardExclusions(input: {
  item: CatalogItemFacts
  venueId: string
  policy: Pick<RecommendationPolicyFacts, 'factMaxAgeDays' | 'availabilityMaxAgeHours'>
  constraints: GuestConstraints
  now: Date
}): ExclusionReason[] {
  const { item, policy, constraints, now } = input
  const reasons: ExclusionReason[] = []
  if (item.venueId !== input.venueId) reasons.push('venue_mismatch')
  if (item.archived) reasons.push('archived')
  if (
    (item.effectiveFrom && now < item.effectiveFrom) ||
    (item.effectiveUntil && now >= item.effectiveUntil)
  )
    reasons.push('not_effective')

  const maxFactAge = policy.factMaxAgeDays * DAY_MS
  if (!item.lastVerifiedAt) reasons.push('facts_unverified')
  else if (age(now, item.lastVerifiedAt) > maxFactAge) reasons.push('facts_stale')

  if (item.priceMinor === null || !item.currency || !item.priceObservedAt)
    reasons.push('price_unknown')
  else if (age(now, item.priceObservedAt) > maxFactAge) reasons.push('price_stale')

  if (item.availability === 'UNAVAILABLE') reasons.push('unavailable')
  else if (item.availability === 'UNKNOWN') reasons.push('availability_unknown')
  else if (
    !item.availabilityObservedAt ||
    age(now, item.availabilityObservedAt) > policy.availabilityMaxAgeHours * HOUR_MS
  )
    reasons.push('availability_stale')

  if (item.hours && !isOpenNow(item.hours, now)) reasons.push('closed')
  if (!isInSeason(item, now)) reasons.push('out_of_season')

  if (constraints.maxPriceMinor !== null && item.priceMinor !== null) {
    // A budget is only comparable when the item is priced in the currency the guest is using.
    if (item.currency !== 'USD' || item.priceMinor > constraints.maxPriceMinor)
      reasons.push('over_budget')
  }

  if (constraints.allergens.length > 0) {
    if (item.allergens.status === 'unknown') reasons.push('allergens_unknown')
    else {
      const itemKeys = new Set(item.allergens.values.flatMap((value) => [...allergenKeys(value)]))
      const conflict = constraints.allergens.some((allergen) =>
        allergen === 'unspecified' ? item.allergens.values.length > 0 : itemKeys.has(allergen),
      )
      if (conflict) reasons.push('allergen_conflict')
    }
  }
  for (const flag of constraints.dietary) {
    if (item.dietary[flag] !== 'yes') {
      reasons.push('dietary_unverified')
      break
    }
  }
  return [...new Set(reasons)]
}

// ---------------------------------------------------------------------------------------------
// Usefulness and decision.
// ---------------------------------------------------------------------------------------------

function categoryRelevance(item: CatalogItemFacts, message: string): number {
  const wantsHot = WANTS_HOT.test(message) && !/\b(iced|cold)\b/iu.test(message)
  if (item.category === 'cold_drink') return wantsHot ? 30 : 60
  if (item.category === 'hot_drink') return wantsHot ? 60 : WANTS_COLD.test(message) ? 0 : 30
  return 0
}

function priceText(item: CatalogItemFacts): string | null {
  if (item.priceMinor === null || !item.currency) return null
  const major = (item.priceMinor / 100).toFixed(2)
  return item.currency === 'USD' ? `$${major}` : `${major} ${item.currency}`
}

function summarize(item: CatalogItemFacts): ItemSummary {
  return {
    itemId: item.id,
    itemVersion: item.version,
    name: item.name,
    description: item.description,
    priceText: priceText(item),
    sizeLabel: item.sizeLabel,
    routeText: item.routeNote,
    allowedClaims: [...item.allowedClaims],
  }
}

function listText(label: string, list: VerifiedList): string {
  if (list.status === 'unknown') return `${label} unknown (not verified; never say it is safe)`
  return list.values.length === 0
    ? `${label}: verified none`
    : `${label}: ${list.values.join(', ')}`
}

function directFacts(item: CatalogItemFacts, exclusions: ExclusionReason[]): DirectItemFacts {
  const priceReasonable =
    !exclusions.includes('price_unknown') && !exclusions.includes('price_stale')
  const availability =
    item.availability === 'UNAVAILABLE'
      ? 'currently unavailable'
      : item.availability === 'UNKNOWN' || exclusions.includes('availability_stale')
        ? 'availability not confirmed right now'
        : 'available'
  const base = summarize(item)
  return {
    ...base,
    priceText: priceReasonable ? base.priceText : null,
    availabilityText: exclusions.includes('closed')
      ? `${availability}; outside its serving hours right now`
      : exclusions.includes('out_of_season')
        ? `${availability}; not in season right now`
        : availability,
    hoursText: item.hours
      ? item.hours.windows
          .map((w) => `days ${w.days.join('/')} ${w.open}-${w.close} (${item.hours!.timeZone})`)
          .join('; ')
      : null,
    allergenText: listText('allergens', item.allergens),
    ingredientText: listText('ingredients', item.ingredients),
    eligibleNow: exclusions.length === 0,
    exclusionReasons: exclusions,
  }
}

export function evaluateRecommendation(input: {
  now: Date
  venueId: string
  venueName: string
  message: string
  /** Earlier guest messages in this session, oldest first, used only for persistent constraints. */
  priorUserMessages?: readonly string[]
  items: readonly CatalogItemFacts[]
  /** Private commercial priorities keyed by item id. Consumed here, never echoed. */
  priorities: Readonly<Record<string, CommercialPriority>>
  policy: RecommendationPolicyFacts
  session: RecommendationSessionState
}): RecommendationDecision {
  const { now, policy, session, message } = input
  const constraints = parseGuestConstraints([...(input.priorUserMessages ?? []), message])
  const intent = classifyRequestIntent(message)
  const declinedNow = isRecommendationDecline(message)

  const base = {
    policyId: policy.id,
    policyVersion: policy.version,
    intent,
    shown: null,
    alternatives: [],
    candidateIds: [],
    exclusions: [],
    direct: [],
    disclosure: null,
    tieBreakDecided: false,
    declinedNow,
  } satisfies Partial<RecommendationDecision>

  if (policy.venueId !== input.venueId) {
    return { ...base, mode: 'none', noShowReason: 'policy_venue_mismatch' }
  }

  const exclusionsFor = (item: CatalogItemFacts) =>
    hardExclusions({ item, venueId: input.venueId, policy, constraints, now })

  // A direct question about a named item is always answered truthfully, even when the policy
  // has expired or the guest declined suggestions.
  const named = input.items.filter(
    (item) => item.venueId === input.venueId && mentionsItem(message, item.name),
  )
  if (named.length > 0) {
    return {
      ...base,
      mode: 'direct',
      noShowReason: 'direct_question',
      direct: named.map((item) => directFacts(item, exclusionsFor(item))),
    }
  }

  const expired = policy.expiresAt !== null && now >= policy.expiresAt
  const shownBefore = new Set(session.shownItemIds)
  const exclusions: RecommendationDecision['exclusions'] = []
  const eligible: Array<{ item: CatalogItemFacts; usefulness: number }> = []
  const relevantItems = input.items.filter((item) => categoryRelevance(item, message) > 0)
  for (const item of input.items) {
    const reasons: ExclusionReason[] = exclusionsFor(item)
    if (!relevantItems.includes(item) && !reasons.includes('venue_mismatch'))
      reasons.push('not_relevant_category')
    if (shownBefore.has(item.id)) reasons.push('already_shown')
    if (reasons.length > 0) exclusions.push({ itemId: item.id, name: item.name, reasons })
    else eligible.push({ item, usefulness: 0 })
  }

  // Usefulness: category fit, a cheapest request, and verified dietary matches.
  const priced = eligible
    .map(({ item }) => item.priceMinor ?? 0)
    .sort((left, right) => left - right)
  for (const entry of eligible) {
    let score = categoryRelevance(entry.item, message)
    if (constraints.cheapest) {
      const rank = priced.indexOf(entry.item.priceMinor ?? 0)
      score += priced.length > 1 ? 30 * (1 - rank / (priced.length - 1)) : 30
    }
    score += Math.min(
      10,
      5 * constraints.dietary.filter((flag) => entry.item.dietary[flag] === 'yes').length,
    )
    entry.usefulness = score
  }

  const boostOf = (itemId: string) => (input.priorities[itemId] === 'HIGH' ? policy.maxBoost : 0)
  const ranked = [...eligible].sort(
    (left, right) =>
      right.usefulness + boostOf(right.item.id) - (left.usefulness + boostOf(left.item.id)) ||
      right.usefulness - left.usefulness ||
      (left.item.priceMinor ?? 0) - (right.item.priceMinor ?? 0) ||
      (left.item.id < right.item.id ? -1 : 1),
  )
  const byUsefulness = [...eligible].sort(
    (left, right) =>
      right.usefulness - left.usefulness ||
      (left.item.priceMinor ?? 0) - (right.item.priceMinor ?? 0) ||
      (left.item.id < right.item.id ? -1 : 1),
  )
  const candidateIds = eligible.map(({ item }) => item.id)
  const common = { ...base, exclusions, candidateIds }

  const none = (noShowReason: NoShowReason): RecommendationDecision => ({
    ...common,
    mode: 'none',
    noShowReason,
    alternatives: ranked.slice(0, MAX_ALTERNATIVES).map(({ item }) => summarize(item)),
  })

  if (expired) return none('policy_expired')
  if (intent === 'blocked') return none('blocked_topic')
  if (intent !== 'refreshment') return none('not_relevant')
  if (session.declined || declinedNow) return none('declined_this_session')
  if (session.unsolicitedShown >= policy.maxUnsolicitedPerSession) return none('repetition_cap')
  if (ranked.length === 0) return none('no_eligible_candidate')

  const top = ranked[0]!
  // Only a HIGH-priority item may be featured, and only if it won on merit plus the bounded boost.
  if (input.priorities[top.item.id] !== 'HIGH') return none('no_competitive_featured_item')

  return {
    ...common,
    mode: 'promoted',
    noShowReason: null,
    shown: summarize(top.item),
    alternatives: ranked.slice(1, 1 + MAX_ALTERNATIVES).map(({ item }) => summarize(item)),
    disclosure: `Featured by ${input.venueName}`,
    tieBreakDecided: byUsefulness[0]!.item.id !== top.item.id,
  }
}
