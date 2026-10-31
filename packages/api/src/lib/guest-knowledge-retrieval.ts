import type { SemanticKnowledgeEntry } from '@pathfinder/db'

const STRICT_LIMIT = 20
const BROAD_LIMIT = 60
// Specific questions need a handful of sources; broad questions (overview, inventory, counts,
// dining) need enough distinct records to synthesize several choices or a complete count.
const RESULT_LIMIT = 8
const BROAD_RESULT_LIMIT = 12
const SEMANTIC_LIMIT = 20
const PER_CONCEPT_LIMIT = 20
const TOTAL_RESULT_CONTENT_CHARS = 20_000
// Reciprocal-rank fusion constant. Semantic and lexical lanes contribute equally so a record
// without a stored embedding can still outrank weaker vector neighbours on a strong text match.
const FUSION_RANK_OFFSET = 10
// The previous production result was the top five vector neighbours. They are always kept, so
// the fused result is never a subset of what guests got before. Neighbours past this rank join
// only when a text match corroborates them, so a weak semantic tail cannot crowd out matches.
const SEMANTIC_UNCORROBORATED_LIMIT = 5

const STOP_WORDS = new Set([
  'a',
  'about',
  'al',
  'also',
  'and',
  'any',
  'anything',
  'are',
  'can',
  'could',
  'cuantas',
  'cuantos',
  'de',
  'do',
  'does',
  'el',
  'en',
  'esta',
  'está',
  'for',
  'give',
  'have',
  'here',
  'how',
  'i',
  'in',
  'is',
  'just',
  'know',
  'la',
  'las',
  'los',
  'many',
  'me',
  'of',
  'on',
  'people',
  'personas',
  'please',
  'pueden',
  'que',
  'should',
  'some',
  'tell',
  'that',
  'the',
  'there',
  'these',
  'they',
  'this',
  'those',
  'to',
  'un',
  'una',
  'want',
  'what',
  'where',
  'which',
  'who',
  'with',
  'would',
  'you',
  'your',
])

const CONCEPTS: readonly (readonly string[])[] = [
  ['capacity', 'occupancy', 'occupants', 'visitors', 'guests', 'fit', 'hold', 'aforo', 'caben'],
  ['photo', 'photos', 'photography', 'camera', 'pictures', 'fotografia', 'fotografía', 'fotos'],
  [
    'hours',
    'opening',
    'closing',
    'open',
    'close',
    'horario',
    'abre',
    'cierra',
    '营业时间',
    '开放时间',
    '営業時間',
    '開館時間',
  ],
  ['bag', 'bags', 'backpack', 'luggage', 'bolsa', 'mochila', 'equipaje'],
  ['gallery', 'galeria', 'galería', 'galerie'],
  ['north', 'norte', 'nord'],
  ['arrival', 'arrive', 'entrance', 'entry', 'llegada', 'llegar', 'entrada', 'acceso'],
  [
    'eat',
    'eating',
    'food',
    'dining',
    'dine',
    'restaurant',
    'restaurants',
    'meal',
    'meals',
    'snack',
    'snacks',
    'lunch',
    'dinner',
    'breakfast',
    'hungry',
    'menu',
    'cafe',
    'comida',
    'comer',
    'restaurante',
    'bite',
    'bites',
  ],
  ['coaster', 'coasters', 'rollercoaster', 'rollercoasters'],
  [
    'restroom',
    'restrooms',
    'bathroom',
    'bathrooms',
    'toilet',
    'toilets',
    'wc',
    '厕所',
    '洗手间',
    'トイレ',
    'お手洗い',
  ],
] as const

export type GuestKnowledgeReader = {
  venueKnowledgeEntry: {
    findMany(args: Record<string, unknown>): Promise<GuestKnowledgeRow[]>
  }
  legacyKnowledgeAdoptionActivation?: {
    findMany(
      args: Record<string, unknown>,
    ): Promise<Array<{ adoption: { legacyKnowledgeEntryId: string } }>>
  }
}

export type GuestKnowledgeRow = {
  id: string
  title: string
  category: string
  content: string
  sourceType: string
  sourceName: string | null
  sourceUrl: string | null
  updatedAt: Date
  lastReviewedAt: Date | null
  contentModuleId?: string | null
  contentRevisionId?: string | null
  contentPublicationId?: string | null
  contentRevision?: {
    createdBy?: string
    effectiveFrom: Date | null
    effectiveUntil: Date | null
    operationalFact: { expiresAt: Date | null } | null
  } | null
  contentPublication?: {
    eventOrder: bigint
    module: { publications: Array<{ id: string; eventOrder: bigint }> }
  } | null
}

export type GuestKnowledgeRetrievalTrace = {
  path: 'semantic+lexical' | 'lexical-fallback'
  retrievedSourceIds: string[]
  retrievedSources: { id: string; version: string | null }[]
  /** Authorized current candidates, including bodies omitted by context/result budgets. */
  observedSources?: { id: string; version: string | null }[]
  excludedSourceIds: string[]
  candidateCounts: { strict: number; broad: number; semantic: number }
  limits: { strict: number; broad: number; result: number }
  partialCoverage: boolean
  truncatedSourceIds: string[]
  publicationAuthority: Array<{
    id: string
    moduleId: string
    revisionId: string
    publicationId: string
    effectiveFrom: string | null
    effectiveUntil: string | null
  }>
  retrievalMs: number
}

export function normalizeGuestText(value: string): string {
  return normalize(value)
}

function normalize(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
}

const CJK_SCRIPT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}/u

// Questions about the place as a whole. Their content words ("place", "park") match nearly
// every record, so they retrieve overview-style records instead.
const OVERVIEW_QUERY =
  /\b(overview|rundown|explain (this|the) (place|park|venue)|(about|describe) (this|the) (place|park|venue|museum|zoo)|what('?s| is) (this|here)( place| park)?\??$|what is (this|the) (place|park)|what (can|is there to) (i|we) do( here)?)\b/u
const OVERVIEW_CONCEPT = ['overview', 'about', 'welcome', 'introduction', 'general information']
const OVERVIEW_GENERIC_TOKENS = new Set([
  'place',
  'park',
  'venue',
  'museum',
  'zoo',
  'garden',
  'explain',
  'describe',
  'here',
  'rundown',
  'overview',
  'whats',
])
const OVERVIEW_SUBJECT = /\b(place|park|venue|museum|zoo|garden|here|rundown|overview)\b/u

// Inventory, count, comparison and open-ended recommendation questions need several distinct
// records; a nearest-neighbour sample of five cannot support a count or a set of choices.
const BROAD_QUERY =
  /\b(how many|number of|list|all (the|of)|every|which|what (are|kinds?|types?|options)|options|recommend|suggest|best|anywhere|places to|where (can|should|do|to) (i|we) )\b/u

// A short referential follow-up ("which one is scariest?") says nothing retrievable on its own.
const FOLLOWUP_QUERY =
  /\b(it|its|that|those|them|they|one|ones|what about|how about|and the|same)\b/u

export function guestQueryIsOverview(query: string): boolean {
  const normalized = normalize(query).trim()
  if (OVERVIEW_QUERY.test(normalized)) return true
  // "what's this park about?": only the place itself remains once filler words are removed.
  const remaining = (normalized.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length > 1 && !STOP_WORDS.has(token) && !OVERVIEW_GENERIC_TOKENS.has(token),
  )
  return remaining.length === 0 && OVERVIEW_SUBJECT.test(normalized)
}

export function guestQueryIsBroad(query: string): boolean {
  const normalized = normalize(query)
  if (guestQueryIsOverview(normalized) || BROAD_QUERY.test(normalized)) return true
  // Open-ended dining questions ("where to eat", "I'm hungry") are choice questions.
  const dining = CONCEPTS.find((group) => group.includes('restaurant'))!
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const contentTokens = tokens.filter((token) => token.length > 2 && !STOP_WORDS.has(token))
  return contentTokens.length <= 2 && tokens.some((token) => dining.includes(token))
}

export function guestQueryIsFollowup(query: string): boolean {
  const tokens = normalize(query).match(/[\p{L}\p{N}]+/gu) ?? []
  return tokens.length > 0 && tokens.length <= 8 && FOLLOWUP_QUERY.test(normalize(query))
}

/** Matches a term at the start of a word, so "eat" matches "eatery" but not "great". */
export function containsGuestTerm(text: string, term: string): boolean {
  if (CJK_SCRIPT.test(term)) return text.includes(term)
  let index = text.indexOf(term)
  while (index >= 0) {
    const previous = index > 0 ? text[index - 1]! : ''
    if (!previous || !/[\p{L}\p{N}]/u.test(previous)) return true
    index = text.indexOf(term, index + 1)
  }
  return false
}

function stemVariants(token: string): string[] {
  if (token.length > 4 && token.endsWith('ies')) return [token, `${token.slice(0, -3)}y`]
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss'))
    return [token, token.slice(0, -1)]
  return [token]
}

export function guestQueryConcepts(query: string): string[][] {
  const overview = guestQueryIsOverview(query)
  const tokens = [...new Set(normalize(query).match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => !(overview && OVERVIEW_GENERIC_TOKENS.has(token)))
    .map((token) => ({
      token,
      concepts: CONCEPTS.filter((items) =>
        items.some((item) => {
          const term = normalize(item)
          return term === token || (CJK_SCRIPT.test(term) && token.includes(term))
        }),
      ),
    }))
    .filter(({ token, concepts }) =>
      concepts.length > 0 ? true : token.length > 2 && !STOP_WORDS.has(token),
    )
    .slice(0, 8)
  const groups: string[][] = overview ? [OVERVIEW_CONCEPT.map(normalize)] : []
  for (const { token, concepts } of tokens) {
    const tokenGroups =
      concepts.length > 0
        ? concepts.map((concept) => concept.map(normalize))
        : [stemVariants(token)]
    for (const group of tokenGroups) {
      if (!groups.some((existing) => existing.join('|') === group.join('|'))) groups.push(group)
    }
  }
  return groups.slice(0, 5)
}

// "that day pass" or "same day tickets" names a product, not an earlier date.
const REFERRED_DATE =
  /\b(?:that|same) (?:date|day|night)\b(?![ -]?(?:pass|passes|ticket|tickets|admission|rate|rates|price|prices|pricing|parking|entry|trip|trips|camp|use|only)\b)/iu
// Words that say when or whether, not what. A follow-up made only of these keeps its subject.
const GENERIC_FOLLOWUP_TOKENS = new Set([
  'date',
  'day',
  'night',
  'time',
  'times',
  'still',
  'then',
  'too',
  'also',
  'well',
  'go',
  'going',
  'visit',
  'come',
  'busy',
  'crowded',
  'late',
  'early',
])
const DATE_WORD =
  /^(?:\d+|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)$/u
const DATE_MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)'
const EXPLICIT_DATE = new RegExp(
  `\\b${DATE_MONTH}\\b|\\b\\d{1,2}(?:st|nd|rd|th)\\b|\\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:today|tomorrow|yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b`,
  'iu',
)

// "those days" or "the latter of those days" points back at every date the visitor just listed.
const REFERRED_DATES =
  /\b(?:the (?:latter|former|first|second) of (?:those|these|the two|both) (?:dates|days|nights)|the (?:latter|former) (?:date|day|night)|(?:those|these|both|either of those) (?:dates|days|nights))\b/iu
// Filler that would otherwise use up the lexical concept budget in a dated follow-up.
const DATED_FOLLOWUP_FILLER =
  /\b(?:now|same|time|times|okay|ok|yes|yeah|actually|again|well|then|too|also|still|though|day|days|date|dates|night|nights)\b/giu
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

function dateTerms(year: number, month: number, day: number): string[] | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null
  const name = MONTHS[month - 1]!
  return [
    `${name} ${day}, ${year}`,
    `${name} ${day} ${year}`,
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  ]
}

/** Two or three dates joined by "and" that share one stated year, for "those days" only. */
function listedPriorDates(previousQuery: string): string[] | null {
  const pattern = new RegExp(
    `\\b(${DATE_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`,
    'giu',
  )
  const matches = [...previousQuery.matchAll(pattern)]
  if (matches.length < 2 || matches.length > 3) return null
  const years = new Set(matches.map((m) => m[3] ?? m[4]).filter(Boolean))
  if (years.size !== 1) return null
  const year = Number([...years][0])
  // Only plain "and" lists: alternatives and ranges must never become a set of dates.
  for (let index = 1; index < matches.length; index++) {
    const previous = matches[index - 1]!
    const between = previousQuery.slice(previous.index! + previous[0].length, matches[index]!.index)
    if (
      !/^\s*(?:,\s*)?(?:and|&)?\s*(?:(?:on|for)\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?$/iu.test(
        between,
      )
    )
      return null
  }
  const remaining = matches
    .reduce((text, m) => text.replace(m[0], ' '), previousQuery)
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/giu, '')
  if (
    EXPLICIT_DATE.test(remaining) ||
    new RegExp(
      `\\b${DATE_MONTH}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:or|through|until|between)\\b|\\bto\\s+\\d|[-–—]\\s*\\d`,
      'iu',
    ).test(remaining)
  )
    return null
  const terms: string[] = []
  for (const m of matches) {
    const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : Number(m[5])
    const next = dateTerms(year, month, Number(m[2] ?? m[6]))
    if (!next) return null
    terms.push(...next)
  }
  return [...new Set(terms)]
}

type CalendarDate = { year: number; month: number; day: number }
type GuestDateMention = { date: CalendarDate | null; text: string; index: number }
/** Exact calendar dates a visitor stated, for lexical retrieval only. */
export type GuestStatedDates = {
  kind: 'single' | 'list' | 'range'
  dates: CalendarDate[]
  terms: string[]
  /** Visitor text that named the dates, removed before subject concepts are built. */
  spans: string[]
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_ABBREVIATIONS = '(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?'
const WEEKDAY_NAME = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)'
const STATED_DATE = new RegExp(
  `(?:\\b(${WEEKDAY_NAME}),?\\s+(?:the\\s+)?)?(?:\\b(${DATE_MONTH}|${MONTH_ABBREVIATIONS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:[:.]\\d|am\\b|pm\\b|a\\.m|p\\.m|%|percent|minutes?|hours?|years?|months?|days?))(?:,?\\s+(20\\d{2})\\b)?|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b)`,
  'giu',
)
// Date forms this parser does not resolve. Their presence makes the stated dates unclear.
const UNRESOLVED_DATE_FORM = new RegExp(
  `\\b\\d{1,2}/\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${DATE_MONTH}\\b|\\bthe\\s+\\d{1,2}(?:st|nd|rd|th)\\b|\\b(?:today|tonight|tomorrow|yesterday)\\b`,
  'iu',
)
// A date introduced by one of these words is a boundary or an exclusion, not a visit day.
const DATE_RELATION_BEFORE =
  /\b(?:after|before|following|prior to|until|till|through|thru|from|since|except|not|instead of|other than|than)\s*$/iu
const RANGE_DAYS_LIMIT = 14
const FULL_DATE_IN_RECORD = new RegExp(
  `\\b(?:${MONTHS.join('|')}) \\d{1,2},? 20\\d{2}\\b|\\b20\\d{2}-\\d{2}-\\d{2}\\b`,
  'u',
)
const DAY_MS = 86_400_000

function calendarDate(year: number, month: number, day: number): CalendarDate | null {
  return dateTerms(year, month, day) ? { year, month, day } : null
}
function dateUtc(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}
function dateFromUtc(ms: number): CalendarDate {
  const value = new Date(ms)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}
function weekdayOf(date: CalendarDate): number {
  return new Date(dateUtc(date)).getUTCDay()
}
function monthNumber(name: string): number {
  const prefix = name.toLowerCase().replace('.', '').slice(0, 3)
  return MONTHS.findIndex((month) => month.startsWith(prefix)) + 1
}

/**
 * Resolves a month and day without a year only when the conversation clock makes it clear:
 * a stated weekday that matches exactly one nearby year, or the next occurrence within about
 * six months. The clock day is widened by one day so every venue time zone is covered.
 */
function inferYear(month: number, day: number, weekday: number | null, clock?: Date | null) {
  if (!clock || Number.isNaN(clock.getTime())) return null
  const today = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()) - DAY_MS
  const candidates = [-1, 0, 1]
    .map((offset) => calendarDate(clock.getUTCFullYear() + offset, month, day))
    .filter((date): date is CalendarDate => date !== null)
  const near =
    weekday === null
      ? candidates.filter((date) => dateUtc(date) >= today && dateUtc(date) <= today + 200 * DAY_MS)
      : candidates.filter(
          (date) =>
            weekdayOf(date) === weekday &&
            dateUtc(date) >= today - 60 * DAY_MS &&
            dateUtc(date) <= today + 366 * DAY_MS,
        )
  return near.length === 1 ? near[0]! : null
}

function statedDateMentions(text: string, clock?: Date | null): GuestDateMention[] {
  return [...text.matchAll(STATED_DATE)].map((match) => {
    const weekday = match[1] ? WEEKDAYS.indexOf(match[1].toLowerCase()) : null
    let date: CalendarDate | null
    if (match[5]) date = calendarDate(Number(match[5]), Number(match[6]), Number(match[7]))
    else {
      const month = monthNumber(match[2]!)
      const day = Number(match[3])
      date = match[4] ? calendarDate(Number(match[4]), month, day) : inferYear(month, day, weekday, clock)
    }
    // A stated weekday that disagrees with the date is a conflict, never a guess.
    if (date && weekday !== null && weekdayOf(date) !== weekday) date = null
    return { date, text: match[0], index: match.index! }
  })
}

function termsFor(dates: CalendarDate[]): string[] {
  return [...new Set(dates.flatMap((date) => dateTerms(date.year, date.month, date.day)!))]
}

/**
 * The one shared parser for exact dates a visitor stated in one message: a single date, a short
 * "and" list, or a bounded "between X and Y" interval (every day in it, never just the two ends).
 * Unresolvable years, conflicting weekdays, alternatives, open ranges and other date forms
 * return null so retrieval falls back to ordinary words.
 */
export function guestStatedDates(text: string, clock?: Date | null): GuestStatedDates | null {
  const mentions = statedDateMentions(text, clock)
  if (mentions.length === 0 || mentions.length > 3) return null
  let remaining = text
  for (const mention of mentions) remaining = remaining.replace(mention.text, ' ')
  if (UNRESOLVED_DATE_FORM.test(remaining) || /\b20\d{2}\b/u.test(remaining)) return null
  for (const mention of mentions) {
    if (DATE_RELATION_BEFORE.test(text.slice(Math.max(0, mention.index - 24), mention.index)))
      if (!/\bbetween\s*$/iu.test(text.slice(0, mention.index))) return null
  }
  const glue = (index: number) =>
    text.slice(mentions[index - 1]!.index + mentions[index - 1]!.text.length, mentions[index]!.index)
  const betweenBefore = (index: number) =>
    /\bbetween\s+(?:(?:on|the)\s+)?$/iu.test(text.slice(0, mentions[index]!.index))
  if (mentions.length === 2 && betweenBefore(0) && /^\s*,?\s*and\s+(?:on\s+)?$/iu.test(glue(1))) {
    let [start, end] = [mentions[0]!.date, mentions[1]!.date]
    const parts = (mention: GuestDateMention) => ({
      month: monthNumber(
        mention.text.match(new RegExp(`${DATE_MONTH}|${MONTH_ABBREVIATIONS}`, 'iu'))?.[0] ?? '',
      ),
      day: Number(mention.text.replace(/20\d{2}/u, '').match(/\d{1,2}/u)?.[0]),
      weekday: mention.text.match(new RegExp(WEEKDAY_NAME, 'iu'))?.[0]?.toLowerCase() ?? null,
    })
    // "between November 7 and November 9, 2026": one trailing year covers both ends.
    if (!start && end && /\b20\d{2}\b/u.test(mentions[1]!.text) && !/\b20\d{2}\b/u.test(mentions[0]!.text)) {
      const { month, day, weekday } = parts(mentions[0]!)
      for (const year of [end.year, end.year - 1]) {
        const candidate = month ? calendarDate(year, month, day) : null
        if (candidate && dateUtc(candidate) <= dateUtc(end)) {
          start =
            weekday && WEEKDAYS[weekdayOf(candidate)] !== weekday ? null : candidate
          break
        }
      }
    }
    // "between December 30 and January 2": an end without a year rolls into the next year.
    if (start && !end && !/\b20\d{2}\b/u.test(mentions[1]!.text)) {
      const { month, day, weekday } = parts(mentions[1]!)
      for (const year of [start.year, start.year + 1]) {
        const candidate = month ? calendarDate(year, month, day) : null
        if (candidate && dateUtc(candidate) >= dateUtc(start)) {
          end = weekday && WEEKDAYS[weekdayOf(candidate)] !== weekday ? null : candidate
          break
        }
      }
    }
    if (start && end && !/\b20\d{2}\b/u.test(mentions[1]!.text) && dateUtc(end) < dateUtc(start)) {
      const rolled = calendarDate(end.year + 1, end.month, end.day)
      end = rolled && dateUtc(rolled) - dateUtc(start) < RANGE_DAYS_LIMIT * DAY_MS ? rolled : end
    }
    if (!start || !end) return null
    const span = (dateUtc(end) - dateUtc(start)) / DAY_MS
    if (span < 1 || span >= RANGE_DAYS_LIMIT) return null
    const dates = Array.from({ length: span + 1 }, (_, offset) =>
      dateFromUtc(dateUtc(start!) + offset * DAY_MS),
    )
    return { kind: 'range', dates, terms: termsFor(dates), spans: mentions.map((m) => m.text) }
  }
  if (mentions.some((mention) => !mention.date)) return null
  if (/\bbetween\b|\bor\b|[-–—]\s*\d|\bto\s+\d/iu.test(remaining)) return null
  for (let index = 1; index < mentions.length; index++) {
    if (!/^\s*(?:,\s*)?(?:and|&)?\s*(?:(?:on|for)\s+)?$/iu.test(glue(index))) return null
  }
  const dates = mentions.map((mention) => mention.date!)
  return {
    kind: dates.length === 1 ? 'single' : 'list',
    dates,
    terms: termsFor(dates),
    spans: mentions.map((mention) => mention.text),
  }
}

// One step from exactly one earlier visitor date: "the next day", "the day after", "the
// following Sunday". Anything longer or vaguer ("next week", "the day after the show") fails closed.
const DATE_OFFSET = new RegExp(
  `\\b(?:the\\s+)?(?:next|following)\\s+day\\b|\\bthe\\s+day\\s+after\\b(?=\\s*(?:[?.!,;]|$|too\\b|then\\b|as well\\b|instead\\b))|\\bthe\\s+(?:next|following)\\s+(${WEEKDAY_NAME})\\b`,
  'iu',
)

/** A one-step offset from the single date the visitor stated in the previous message. */
export function guestOffsetDateConcept(
  query: string,
  previousQuery?: string | null,
  clock?: Date | null,
): GuestStatedDates | null {
  if (!previousQuery) return null
  const offsets = [...query.matchAll(new RegExp(DATE_OFFSET.source, 'giu'))]
  if (offsets.length !== 1) return null
  const rest = query.replace(offsets[0]![0], ' ')
  if (statedDateMentions(rest, clock).length || UNRESOLVED_DATE_FORM.test(rest)) return null
  if (/\b(?:week|weeks|month|months|year|years|before|previous|earlier)\b/iu.test(rest)) return null
  if (PRIOR_DATE_CORRECTION.test(previousQuery)) return null
  const prior = guestStatedDates(previousQuery, clock)
  if (!prior || prior.kind !== 'single') return null
  const anchor = dateUtc(prior.dates[0]!)
  const weekdayName = offsets[0]![1]
  let next: number
  if (weekdayName) {
    const wanted = WEEKDAYS.indexOf(weekdayName.toLowerCase())
    const ahead = (wanted - weekdayOf(prior.dates[0]!) + 7) % 7 || 7
    next = anchor + ahead * DAY_MS
  } else next = anchor + DAY_MS
  const date = dateFromUtc(next)
  return { kind: 'single', dates: [date], terms: termsFor([date]), spans: [offsets[0]![0]] }
}

const PRIOR_DATE_CORRECTION =
  /\b(?:not|never|instead|actually|correction|corrected|changed|cancelled|canceled|forget|ignore|previously|last|ago|was|were)\b|\bno longer\b|n['’]t\b/iu

/** Explicit dates in the immediately preceding visitor query, for lexical retrieval only:
 * one date for "that day", or a short "and" list or bounded "between" interval for "those
 * days". No assistant text or older conversation search is accepted. Ambiguity fails closed.
 */
export function guestPriorDateConcept(
  query: string,
  previousQuery?: string | null,
  clock?: Date | null,
): string[] | null {
  if (!previousQuery || EXPLICIT_DATE.test(query)) return null
  const plural = REFERRED_DATES.test(query)
  if (!plural && !REFERRED_DATE.test(query)) return null
  // An offset or rejection changes the referent; never reuse its exact calendar date.
  if (
    /\b(?:not|never|instead|different|another|after|before|following|next|previous|later|earlier|week|month|year)\b|n['’]t\b/iu.test(
      query,
    )
  )
    return null
  if (PRIOR_DATE_CORRECTION.test(previousQuery)) return null
  if (plural) {
    const listed = listedPriorDates(previousQuery)
    if (listed) return listed
    const interval = guestStatedDates(previousQuery, clock)
    return interval && interval.kind === 'range' ? interval.terms : null
  }
  const pattern = new RegExp(
    `\\b(${DATE_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`,
    'giu',
  )
  const dates = [...previousQuery.matchAll(pattern)]
  if (dates.length !== 1) {
    // No stated year: accept one date only when the conversation clock makes its year clear.
    const stated = dates.length === 0 ? guestStatedDates(previousQuery, clock) : null
    return stated && stated.kind === 'single' ? stated.terms : null
  }
  const match = dates[0]!
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : Number(match[5])
  const terms = dateTerms(Number(match[3] ?? match[4]), month, Number(match[2] ?? match[6]))
  if (!terms) return null
  const remaining = previousQuery
    .replace(match[0], '')
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/giu, '')
  // Partial dates, ranges and alternatives must never select one date silently.
  if (
    EXPLICIT_DATE.test(remaining) ||
    new RegExp(
      `\\b${DATE_MONTH}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:or|through|until|between)\\b|\\bto\\s+\\d|[-–—]\\s*\\d`,
      'iu',
    ).test(remaining)
  )
    return null
  return terms
}

/**
 * Lexical concept groups for this turn. A short referential follow-up borrows the previous
 * visitor message's concepts so "which one is scariest?" keeps the earlier topic.
 */
export function guestRetrievalConcepts(
  query: string,
  previousQuery?: string | null,
  clock?: Date | null,
): {
  ownConcepts: string[][]
  concepts: string[][]
  broad: boolean
  dateConcept: string[] | null
} {
  // This message's own dates win; then a one-step offset; then "that day" / "those days".
  const ownDates = guestStatedDates(query, clock)
  const offsetDate = ownDates ? null : guestOffsetDateConcept(query, previousQuery, clock)
  const priorDate =
    ownDates?.terms ?? offsetDate?.terms ?? guestPriorDateConcept(query, previousQuery, clock)
  let subjectText = query
  for (const span of [...(ownDates?.spans ?? []), ...(offsetDate?.spans ?? [])])
    subjectText = subjectText.replace(span, ' ')
  if (ownDates?.kind === 'range') subjectText = subjectText.replace(/\bbetween\b/iu, ' ')
  const ownConcepts = guestQueryConcepts(
    priorDate
      ? subjectText
          .replace(REFERRED_DATES, ' ')
          .replace(REFERRED_DATE, ' ')
          .replace(DATED_FOLLOWUP_FILLER, ' ')
      : query,
  )
  // With an exact prior date, a newly named subject replaces the old one ("what about rides
  // that day?"); a follow-up that names none ("is it open that day?") keeps the old subject.
  // Without one, the ordinary follow-up rule applies unchanged.
  const keepsPreviousSubject = priorDate
    ? ownConcepts.every(
        (group) =>
          group.includes('hours') || group.every((term) => GENERIC_FOLLOWUP_TOKENS.has(term)),
      )
    : true
  const followupConcepts =
    keepsPreviousSubject && previousQuery && guestQueryIsFollowup(query)
      ? guestQueryConcepts(previousQuery).filter(
          (group) =>
            !ownConcepts.some((existing) => existing.join('|') === group.join('|')) &&
            // The exact date replaces loose month or weekday words from the earlier message.
            !(
              priorDate &&
              group.every((term) => DATE_WORD.test(term) || GENERIC_FOLLOWUP_TOKENS.has(term))
            ),
        )
      : []
  return {
    ownConcepts,
    concepts: priorDate
      ? [...[...ownConcepts, ...followupConcepts].slice(0, 5), priorDate]
      : [...ownConcepts, ...followupConcepts].slice(0, 6),
    dateConcept: priorDate,
    broad:
      guestQueryIsBroad(query) ||
      (followupConcepts.length > 0 && Boolean(previousQuery) && guestQueryIsBroad(previousQuery!)),
  }
}

function conceptFieldMatches(row: GuestKnowledgeRow, concept: string[]) {
  return {
    title: concept.some((term) => containsGuestTerm(normalize(row.title), term)),
    category: concept.some((term) => containsGuestTerm(normalize(row.category), term)),
    content: concept.some((term) => containsGuestTerm(normalize(row.content), term)),
  }
}

/**
 * Rarer concepts carry more weight, so "which coasters are open" ranks the few coaster records
 * above the many records that merely mention opening hours.
 */
function conceptWeights(rows: GuestKnowledgeRow[], concepts: string[][]): number[] {
  if (concepts.length < 2 || rows.length === 0) return concepts.map(() => 1)
  return concepts.map((concept) => {
    const matching = rows.filter((row) => {
      const match = conceptFieldMatches(row, concept)
      return match.title || match.category || match.content
    }).length
    return matching === 0 ? 1 : Math.min(4, 1 + Math.log2(rows.length / matching))
  })
}

function lexicalScore(
  row: GuestKnowledgeRow,
  concepts: string[][],
  weights: number[] = concepts.map(() => 1),
): number {
  let score = 0
  concepts.forEach((concept, index) => {
    const match = conceptFieldMatches(row, concept)
    const weight = weights[index] ?? 1
    if (match.title) score += 8 * weight
    if (match.category) score += 5 * weight
    if (match.content) score += 2 * weight
  })
  if (score === 0) return 0
  const reviewed = row.lastReviewedAt?.getTime() ?? 0
  return score + Math.min(1, reviewed / 10 ** 15)
}

export function guestKnowledgeSelectShape() {
  return {
    id: true,
    title: true,
    category: true,
    content: true,
    sourceType: true,
    sourceName: true,
    sourceUrl: true,
    updatedAt: true,
    lastReviewedAt: true,
    contentModuleId: true,
    contentRevisionId: true,
    contentPublicationId: true,
    contentRevision: {
      select: {
        createdBy: true,
        effectiveFrom: true,
        effectiveUntil: true,
        operationalFact: { select: { expiresAt: true } },
      },
    },
    contentPublication: {
      select: {
        eventOrder: true,
        module: {
          select: {
            publications: {
              select: { id: true, eventOrder: true },
              orderBy: { eventOrder: 'desc' },
              take: 1,
            },
          },
        },
      },
    },
  }
}

function textClause(term: string) {
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { category: { contains: term, mode: 'insensitive' } },
      { content: { contains: term, mode: 'insensitive' } },
    ],
  }
}

/** The guest-visible Knowledge scope: tenant, venue, visibility, publication and source fences. */
export function guestKnowledgeScope(scopeParams: {
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  asOf: Date
}) {
  const publicationAuthority = {
    OR: [
      { contentModuleId: null },
      {
        contentPublication: { action: 'PUBLISH' },
        contentRevision: {
          audience: 'PUBLIC',
          AND: [
            { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: scopeParams.asOf } }] },
            { OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: scopeParams.asOf } }] },
            {
              OR: [
                { kind: { not: 'OPERATIONAL_FACT' } },
                { operationalFact: { expiresAt: null } },
                { operationalFact: { expiresAt: { gt: scopeParams.asOf } } },
              ],
            },
          ],
        },
      },
    ],
  }
  const adoptionAuthority = {
    OR: [
      { contentModuleId: { not: null } },
      { universalContentAdoption: { is: null } },
      { universalContentAdoption: { is: { activation: { is: null } } } },
    ],
  }
  return {
    tenantId: scopeParams.tenantId,
    venueId: scopeParams.venueId,
    isEnabled: true,
    // Connected-source facts have an additional approval/freshness fence. The cached source
    // reader owns that check; lexical or embedding hits must never bypass it.
    sourceType: { not: 'SOURCE_CONNECTION' },
    ...(scopeParams.includeSecondLayer ? {} : { visibility: 'PUBLIC' }),
    AND: [
      publicationAuthority,
      adoptionAuthority,
      {
        OR: [
          // The relation also uses required tenant/venue keys. Prisma's relation-null
          // predicate tests that composite key and excludes ordinary legacy rows.
          // Test the nullable revision key itself; connected revisions remain fenced.
          { contentRevisionId: null },
          { contentRevision: { is: { NOT: { createdBy: { startsWith: 'source-connection:' } } } } },
        ],
      },
    ],
  }
}

/** Rejects connected-source rows and module rows whose publication is no longer the latest. */
export function hasCurrentGuestPublicationAuthority(row: GuestKnowledgeRow): boolean {
  if (
    row.sourceType === 'SOURCE_CONNECTION' ||
    row.contentRevision?.createdBy?.startsWith('source-connection:')
  )
    return false
  if (!row.contentModuleId) return true
  const latest = row.contentPublication?.module.publications[0]
  return Boolean(
    latest &&
    latest.id === row.contentPublicationId &&
    latest.eventOrder === row.contentPublication?.eventOrder,
  )
}

export async function retrieveGuestKnowledge(params: {
  reader: unknown
  query: string
  tenantId: string
  venueId: string
  includeSecondLayer: boolean
  queryEmbedding: number[] | null
  /**
   * The visitor's previous message. Used only for lexical matching when the current message is a
   * short referential follow-up, so "which one is scariest?" keeps the earlier coaster topic.
   */
  previousQuery?: string | null
  /** Must apply this exact tenant, venue, and visibility scope before returning candidates. */
  semanticSearch?: (scope: {
    tenantId: string
    venueId: string
    includeSecondLayer: boolean
  }) => Promise<SemanticKnowledgeEntry[]>
  now?: () => number
  asOf?: Date
}): Promise<{ entries: SemanticKnowledgeEntry[]; trace: GuestKnowledgeRetrievalTrace }> {
  const reader = params.reader as GuestKnowledgeReader
  const started = (params.now ?? performance.now.bind(performance))()
  const asOf = params.asOf ?? new Date()
  const {
    ownConcepts,
    concepts,
    dateConcept,
    broad: broadQuestion,
  } = guestRetrievalConcepts(params.query, params.previousQuery, asOf)
  const resultLimit = broadQuestion ? BROAD_RESULT_LIMIT : RESULT_LIMIT
  const scope = guestKnowledgeScope({
    tenantId: params.tenantId,
    venueId: params.venueId,
    includeSecondLayer: params.includeSecondLayer,
    asOf,
  })
  const strictWhere = concepts.length
    ? {
        ...scope,
        AND: [
          ...scope.AND,
          ...(ownConcepts.length ? ownConcepts : concepts).map((group) => ({
            OR: group.map(textClause).flatMap((clause) => clause.OR),
          })),
        ],
      }
    : { ...scope, id: '__no_query_terms__' }
  const broadWhere = concepts.length
    ? {
        ...scope,
        OR: concepts.flatMap((group) => group.map(textClause).flatMap((clause) => clause.OR)),
      }
    : { ...scope, id: '__no_query_terms__' }
  // Exact visitor dates get their own bounded selection, so recent off-date schedules cannot
  // crowd the dated records out of the shared recency-ordered queries.
  const datedWhere = dateConcept
    ? {
        ...scope,
        AND: [
          ...scope.AND,
          { OR: dateConcept.map(textClause).flatMap((clause) => clause.OR) },
        ],
      }
    : null
  const [strict, broadAll, semantic, activated, dated] = await Promise.all([
    reader.venueKnowledgeEntry.findMany({
      where: strictWhere,
      select: guestKnowledgeSelectShape(),
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: STRICT_LIMIT,
    }),
    reader.venueKnowledgeEntry.findMany({
      where: broadWhere,
      select: guestKnowledgeSelectShape(),
      orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
      take: BROAD_LIMIT,
    }),
    params.queryEmbedding && params.semanticSearch
      ? params
          .semanticSearch({
            tenantId: params.tenantId,
            venueId: params.venueId,
            includeSecondLayer: params.includeSecondLayer,
          })
          .catch(() => [])
      : Promise.resolve([]),
    reader.legacyKnowledgeAdoptionActivation
      ? reader.legacyKnowledgeAdoptionActivation.findMany({
          where: { tenantId: params.tenantId, venueId: params.venueId },
          select: { adoption: { select: { legacyKnowledgeEntryId: true } } },
        })
      : Promise.resolve([]),
    datedWhere
      ? reader.venueKnowledgeEntry.findMany({
          where: datedWhere,
          select: guestKnowledgeSelectShape(),
          orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
          take: PER_CONCEPT_LIMIT,
        })
      : Promise.resolve([] as GuestKnowledgeRow[]),
  ])
  const activatedLegacyIds = new Set(activated.map((row) => row.adoption.legacyKnowledgeEntryId))
  // Revalidate bounded semantic identities after the parallel searches. This
  // also covers sources that disappeared from the public lexical scope and
  // corrections whose old content survives in an earlier semantic result.
  const semanticCandidates = semantic.slice(0, SEMANTIC_LIMIT)
  const semanticRows = semanticCandidates.length
    ? await reader.venueKnowledgeEntry.findMany({
        where: { ...scope, id: { in: semanticCandidates.map((entry) => entry.id) } },
        select: guestKnowledgeSelectShape(),
        take: SEMANTIC_LIMIT,
      })
    : []
  // When several concepts saturate the single recency-ordered OR query, the most common concept
  // can fill the bound. Each concept then gets its own bounded query so rarer concepts keep
  // candidates (for example coaster records in "which coasters are open").
  const perConcept =
    broadAll.length >= BROAD_LIMIT && concepts.length > 1
      ? await Promise.all(
          concepts.map((group) =>
            reader.venueKnowledgeEntry.findMany({
              where: { ...scope, OR: group.map(textClause).flatMap((clause) => clause.OR) },
              select: guestKnowledgeSelectShape(),
              orderBy: [{ lastReviewedAt: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }],
              take: PER_CONCEPT_LIMIT,
            }),
          ),
        )
      : []
  const broad = [...broadAll, ...perConcept.flatMap((rows) => rows ?? []), ...(dated ?? [])]
  const currentSemanticRows = new Map(semanticRows.map((row) => [row.id, row]))
  const changedSemanticIds = new Set(
    semanticCandidates
      .filter((entry) => {
        const current = currentSemanticRows.get(entry.id)
        return (
          current &&
          (current.title !== entry.title ||
            current.category !== entry.category ||
            current.content !== entry.content)
        )
      })
      .map((entry) => entry.id),
  )
  // Concurrent retrieval lanes can observe different publication heads. A
  // rejected authority observation must win over another lane's older hit.
  const authorityExcludedIds = new Set(
    [...strict, ...broad, ...semanticRows]
      .filter((row) => !hasCurrentGuestPublicationAuthority(row))
      .map((row) => row.id),
  )
  for (const entry of semanticCandidates) {
    if (!currentSemanticRows.has(entry.id)) authorityExcludedIds.add(entry.id)
  }
  const lexicalPool = [
    ...new Map(
      [...strict, ...broad, ...semanticRows.filter((row) => changedSemanticIds.has(row.id))].map(
        (row) => [row.id, row],
      ),
    ).values(),
  ]
    .filter((row) => !authorityExcludedIds.has(row.id))
    .filter((row) => !activatedLegacyIds.has(row.id))
  const weights = conceptWeights(lexicalPool, concepts)
  // A schedule that names other full dates but not the visitor's date answers a different day:
  // it ranks below the dated record. Records without full dates are ranked as before.
  const offDate = (row: Pick<GuestKnowledgeRow, 'title' | 'category' | 'content'>) =>
    dateConcept !== null &&
    FULL_DATE_IN_RECORD.test(normalize(`${row.title} ${row.content}`)) &&
    !conceptFieldMatches(row as GuestKnowledgeRow, dateConcept).content &&
    !conceptFieldMatches(row as GuestKnowledgeRow, dateConcept).title
  const scoredLexical = lexicalPool.map((row) => ({
    row,
    score: lexicalScore(row, concepts, weights) * (offDate(row) ? 0.5 : 1),
  }))
  const policyExcludedIds = [
    ...authorityExcludedIds,
    // A changed semantic snapshot keeps no vector authority; it must earn a current text match.
    // Ordinary substring candidates that fail word matching are simply not lexical hits.
    ...scoredLexical
      .filter(({ row, score }) => score <= 0 && changedSemanticIds.has(row.id))
      .map(({ row }) => row.id),
  ]
  const lexical = scoredLexical
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.row.updatedAt.getTime() - a.row.updatedAt.getTime() ||
        a.row.id.localeCompare(b.row.id),
    )
  const policyExcluded = new Set(policyExcludedIds)
  // Fuse both lanes by rank. Semantic-first concatenation let five vector neighbours crowd out
  // every lexical match, so records without a stored embedding could never reach the guest.
  const fused = new Map<string, { entry: SemanticKnowledgeEntry; score: number; order: number }>()
  let semanticRank = 0
  for (const entry of semanticCandidates) {
    const current = currentSemanticRows.get(entry.id)
    if (
      current &&
      !changedSemanticIds.has(entry.id) &&
      !policyExcluded.has(entry.id) &&
      !activatedLegacyIds.has(entry.id)
    ) {
      if (
        semanticRank >= SEMANTIC_UNCORROBORATED_LIMIT &&
        lexical.length > 0 &&
        !lexical.some(({ row }) => row.id === entry.id)
      )
        continue
      semanticRank += 1
      fused.set(entry.id, {
        entry: { ...current, distance: entry.distance, content: current.content },
        score: 1 / (FUSION_RANK_OFFSET + semanticRank),
        order: fused.size,
      })
    }
  }
  lexical.forEach(({ row, score }, index) => {
    const contribution = 1 / (FUSION_RANK_OFFSET + index + 1)
    const existing = fused.get(row.id)
    if (existing) {
      existing.score += contribution
      return
    }
    fused.set(row.id, {
      entry: { ...row, distance: Math.max(0, 1 - score / 40) },
      score: contribution,
      order: fused.size,
    })
  })
  // A stated date also outranks vector similarity: off-date schedules lose half their fused
  // score and their guaranteed slot, so they cannot use the budget the dated record needs.
  const candidates = [...fused.values()]
    .map((item) => ({ ...item, score: item.score * (offDate(item.entry) ? 0.5 : 1) }))
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(({ entry }) => entry)
  const guaranteed = new Set(
    candidates
      .filter((entry) => !offDate(entry))
      .filter((entry) =>
        semanticCandidates
          .slice(0, SEMANTIC_UNCORROBORATED_LIMIT)
          .some((hit) => hit.id === entry.id),
      )
      .map((entry) => entry.id),
  )
  const selected = candidates.slice(0, resultLimit)
  // Restore any guaranteed vector hit that fused ranking pushed past the budget by replacing the
  // lowest-ranked non-guaranteed entries.
  for (const entry of candidates.slice(resultLimit)) {
    if (!guaranteed.has(entry.id)) continue
    let replaceAt = selected.length - 1
    while (replaceAt >= 0 && guaranteed.has(selected[replaceAt]!.id)) replaceAt -= 1
    if (replaceAt < 0) break
    selected.splice(replaceAt, 1)
    selected.push(entry)
  }
  // Whole source records preserve their governing conditions. Never splice a policy.
  let contentChars = 0
  const entries = selected.filter((entry) => {
    if (contentChars + entry.content.length > TOTAL_RESULT_CONTENT_CHARS) return false
    contentChars += entry.content.length
    return true
  })
  const selectedIds = new Set(entries.map((entry) => entry.id))
  const lexicalVersions = new Map(
    [...lexical.map(({ row }) => row), ...semanticRows].map((row) => [
      row.id,
      row.updatedAt.toISOString(),
    ]),
  )
  const truncatedSourceIds: string[] = []
  return {
    entries,
    trace: {
      path: params.queryEmbedding ? 'semantic+lexical' : 'lexical-fallback',
      observedSources: candidates.map((entry) => {
        const updatedAt = (entry as SemanticKnowledgeEntry & { updatedAt?: unknown }).updatedAt
        return { id: entry.id, version: updatedAt instanceof Date ? updatedAt.toISOString() : null }
      }),
      retrievedSourceIds: entries.map((entry) => entry.id),
      retrievedSources: entries.map((entry) => ({
        id: entry.id,
        version: lexicalVersions.get(entry.id) ?? null,
      })),
      excludedSourceIds: [
        ...new Set([
          ...policyExcludedIds,
          ...activatedLegacyIds,
          ...semantic.slice(SEMANTIC_LIMIT).map((entry) => entry.id),
          ...candidates.filter((entry) => !selectedIds.has(entry.id)).map((entry) => entry.id),
        ]),
      ],
      candidateCounts: { strict: strict.length, broad: broad.length, semantic: semantic.length },
      limits: { strict: STRICT_LIMIT, broad: BROAD_LIMIT, result: resultLimit },
      partialCoverage:
        candidates.length > entries.length ||
        strict.length === STRICT_LIMIT ||
        broad.length === BROAD_LIMIT ||
        semantic.length >= SEMANTIC_LIMIT ||
        truncatedSourceIds.length > 0,
      truncatedSourceIds,
      publicationAuthority: entries.flatMap((entry) => {
        const row =
          currentSemanticRows.get(entry.id) ??
          lexical.find((candidate) => candidate.row.id === entry.id)?.row
        return row?.contentModuleId && row.contentRevisionId && row.contentPublicationId
          ? [
              {
                id: row.id,
                moduleId: row.contentModuleId,
                revisionId: row.contentRevisionId,
                publicationId: row.contentPublicationId,
                effectiveFrom: row.contentRevision?.effectiveFrom?.toISOString() ?? null,
                effectiveUntil: row.contentRevision?.effectiveUntil?.toISOString() ?? null,
              },
            ]
          : []
      }),
      retrievalMs: Math.max(0, (params.now ?? performance.now.bind(performance))() - started),
    },
  }
}
