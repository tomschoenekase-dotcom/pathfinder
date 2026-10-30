// Focus facts: the complete own records of the places and topics the visitor named, repeated
// next to the question with each record fenced to its subject.
//
// Why this exists (2026-10-30 Luna regression traces): the deciding record was almost always in
// the prompt, inside a 20k-100k character venue guide, and the retrieval section near the
// question only named topics. Luna's errors were binding errors, not retrieval misses: a status,
// rule, price or date from one record attached to a neighbour (a ride closure applied to dining,
// another ride's adult rule turned into "no rule here", a day-admission price given for a
// separately sold product). Generic prompt rules against this already existed and did not hold.
// This module changes the structure instead: it copies only the named subjects' own records,
// says which asked-about kinds of fact each record does not state, and computes the few date
// boundaries that the records state unambiguously. It never hides, rewrites or judges a record,
// and it adds no model call.

import { guestPlaceIdentityKey } from './guest-place-identity'

export const GUEST_FOCUS_FACTS_VERSION = 'guest-focus-facts-v1'

export type GuestFocusFactsMode = 'off' | 'on' | 'luna'

/** GUEST_CHAT_FOCUS_FACTS: "on" for every model, "luna" for Luna-family routes only, else off. */
export function guestFocusFactsMode(
  env: Record<string, string | undefined> = process.env,
): GuestFocusFactsMode {
  const value = env.GUEST_CHAT_FOCUS_FACTS?.trim().toLowerCase()
  return value === 'on' || value === 'luna' ? value : 'off'
}

export function guestFocusFactsForModel(
  mode: GuestFocusFactsMode,
  primaryModelKey: string | null | undefined,
): boolean {
  if (mode === 'on') return true
  return mode === 'luna' && /^guest-chat-luna(?:-|$)/u.test(primaryModelKey ?? '')
}

export type GuestFocusKnowledge = {
  id?: string
  title: string
  category?: string | null
  content: string
}

export type GuestFocusPlace = {
  id?: string
  name: string
  areaName?: string | null
  shortDescription?: string | null
  longDescription?: string | null
  hours?: string | null
}

export type GuestFocusAttribute = 'price' | 'height' | 'age' | 'adult' | 'hours' | 'speed'

const ATTRIBUTE_LABEL: Record<GuestFocusAttribute, string> = {
  price: 'a price',
  height: 'a height rule or measurement',
  age: 'an age rule',
  adult: 'an adult or companion rule',
  hours: 'hours or an open/closed status',
  speed: 'a speed',
}

// What the visitor asked about. Deliberately narrow: a missed class only means no note.
const QUESTION_ATTRIBUTE: Record<GuestFocusAttribute, RegExp> = {
  price: /\b(?:price|prices|cost|costs|how much|fee|fees|charge|pay|paying)\b|\$/iu,
  height: /\b(?:tall|height|inches|inch|cm|centimet(?:er|re)s?|short)\b/iu,
  age: /\b(?:age|ages|aged|how old|year[- ]old|years? old|yrs?)\b/iu,
  adult:
    /\b(?:adults?|alone|accompan\w*|supervis\w*|companion|chaperon\w*|by (?:him|her|them)sel(?:f|ves)|with (?:me|us|a parent|an adult))\b/iu,
  hours:
    /\b(?:open|opens|opening|close|closes|closed|closing|hours|today|tonight|tomorrow|this weekend|still running|running)\b/iu,
  speed: /\b(?:fast|faster|fastest|speed|mph|km\/h)\b/iu,
}

// Whether a record states that kind of fact at all. Generous on purpose: a false "stated" only
// suppresses a note, while a false "not stated" would wrongly call a fact unknown.
const RECORD_ATTRIBUTE: Record<GuestFocusAttribute, RegExp> = {
  price: /\$\s?\d|\bfree\b|\bno charge\b|\bincluded\b|\bincludes\b/iu,
  height: /\bheight\b|\btall\b|\b\d+(?:\.\d+)?\s?(?:in\b|inch|inches|cm\b|")/iu,
  age: /\bages?\b|\baged\b|\byears? old\b|\b\d+\s?\+|\bunder \d+\b|\b\d+ and (?:older|over|up)\b/iu,
  adult: /\badults?\b|\baccompan\w*|\bcompanion|\bsupervis\w*|\bchaperon\w*|\bguardian/iu,
  hours:
    /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)|\bnoon\b|\bmidnight\b|\bhours\b|\bopen\w*\b|\bclos\w*\b|\bseason\b|\bdaily\b/iu,
  speed: /\bmph\b|\bkm\/h\b|\bspeed\b/iu,
}

// "Ask staff about opening hours" or "confirm the current price" defers a fact; it does not
// state it, so such clauses are removed before testing whether a record states that fact.
const DEFERRAL =
  /\b(?:ask|check|confirm|call|contact|verify)\b[^.;\n]{0,60}?\b(?:hours|opening|times?|schedule|price|prices|cost|rules?|requirements?|availability|status)\b[^.;\n]*/giu

function statesAttribute(text: string, attribute: GuestFocusAttribute): boolean {
  return RECORD_ATTRIBUTE[attribute].test(text.replace(DEFERRAL, ' '))
}

export function guestFocusAskedAttributes(question: string): GuestFocusAttribute[] {
  return (Object.keys(QUESTION_ATTRIBUTE) as GuestFocusAttribute[]).filter((attribute) =>
    QUESTION_ATTRIBUTE[attribute].test(question),
  )
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const DATE = String.raw`(${MONTH_NAMES.join('|')})\s+(\d{1,2}),\s+(\d{4})`

function parseDate(month: string, day: string, year: string): Date | null {
  const monthIndex = MONTH_NAMES.indexOf(month)
  const date = new Date(Date.UTC(Number(year), monthIndex, Number(day)))
  return monthIndex >= 0 && date.getUTCDate() === Number(day) ? date : null
}

function formatDate(date: Date): string {
  return `${WEEKDAYS[date.getUTCDay()]}, ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000)
}

// Only phrasings whose meaning does not depend on reading "closes <date>" one way or the other.
const BOUNDARY_PATTERNS: ReadonlyArray<{ pattern: RegExp; note: (date: Date) => string }> = [
  {
    // "before the November 1, 2026 seasonal closure"
    pattern: new RegExp(
      String.raw`\bbefore the ${DATE}\s+(?:seasonal\s+|season\s+)?closure\b`,
      'giu',
    ),
    note: (date) =>
      `${formatDate(date)} is the closure date, so it is not an open day; the last possible open day is ${formatDate(addDays(date, -1))}.`,
  },
  {
    // "closed for the 2026 season after October 25, 2026"
    pattern: new RegExp(String.raw`\bclosed\b[^.;\n]{0,40}?\bafter ${DATE}`, 'giu'),
    note: (date) =>
      `${formatDate(date)} is the last listed open day; it is closed from ${formatDate(addDays(date, 1))}.`,
  },
  {
    // "closed from November 3, 2026"
    pattern: new RegExp(
      String.raw`\bclosed\b[^.;\n]{0,40}?\b(?:from|starting|beginning|as of|on and after)\s+${DATE}`,
      'giu',
    ),
    note: (date) =>
      `It is closed on ${formatDate(date)} and after it, unless a record gives a reopening date.`,
  },
]

export function guestFocusDateBoundaryNotes(text: string): string[] {
  const notes = new Set<string>()
  for (const { pattern, note } of BOUNDARY_PATTERNS)
    for (const match of text.matchAll(pattern)) {
      const date = parseDate(match[1]!, match[2]!, match[3]!)
      if (date) notes.add(note(date))
    }
  return [...notes]
}

type FocusSubject = {
  key: string
  name: string
  records: string[]
}

function phraseAt(query: string, phrase: string): boolean {
  return phrase.length >= 3 && ` ${query} `.includes(` ${phrase} `)
}

// "picnic pod" names the "Picnic pods" record and "rides" names "Ride"; nothing looser.
function namesPhrase(query: string, key: string): boolean {
  return (
    phraseAt(query, key) ||
    (key.endsWith('s') && phraseAt(query, key.slice(0, -1))) ||
    phraseAt(query, `${key}s`)
  )
}

// Generic one-word titles ("Hours", "Tickets", "Parking") name a topic, not a subject the visitor
// is asking about. Those topics are still in the guide and in retrieval.
function isSpecificName(key: string): boolean {
  return key.includes(' ') || key.length >= 6
}

function placeText(place: GuestFocusPlace): string {
  return [
    place.areaName ? `Area: ${place.areaName}` : null,
    place.shortDescription,
    place.longDescription,
    place.hours ? `Hours: ${place.hours}` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

function namedSubjects(
  query: string,
  knowledge: ReadonlyArray<GuestFocusKnowledge>,
  places: ReadonlyArray<GuestFocusPlace>,
): FocusSubject[] {
  const normalized = guestPlaceIdentityKey(query)
  const subjects = new Map<string, FocusSubject>()
  const add = (name: string, record: string) => {
    const key = guestPlaceIdentityKey(name)
    if (!key || !isSpecificName(key) || !namesPhrase(normalized, key) || !record.trim()) return
    const subject = subjects.get(key) ?? { key, name, records: [] }
    if (!subject.records.includes(record)) subject.records.push(record)
    subjects.set(key, subject)
  }
  for (const entry of knowledge) add(entry.title, entry.content)
  for (const place of places) add(place.name, placeText(place))
  // A name inside a longer named subject ("Hawg" in "Steel Hawg") is the same mention.
  const ordered = [...subjects.values()].sort((left, right) => right.key.length - left.key.length)
  return ordered.filter(
    (subject, index) =>
      !ordered.slice(0, index).some((longer) => phraseAt(longer.key, subject.key)),
  )
}

export type GuestFocusFacts = {
  /** Instruction text; belongs outside the untrusted data fence. */
  rule: string
  /** Escaped record data; belongs inside the untrusted data fence. */
  data: string
  subjects: string[]
  fromPreviousQuestion: boolean
  askedAttributes: GuestFocusAttribute[]
  truncated: boolean
}

export const GUEST_FOCUS_FACTS_RULE =
  'FOCUS FACTS: Each <focus_subject> block below repeats, from the VENUE GUIDE, the complete records of a place or topic the visitor named. Everything inside a block is about that subject only. A status, rule, price, date or qualifier stated for one subject, or in a record about other things, never transfers to another subject unless a record says it applies to it. "Not stated in its records" means unknown: answer what is known, say plainly what is not listed, and never fill the gap from a neighbour or call it absent, free, closed, not required or not applicable. A qualifier applies only to the requirements it names. Answer the visitor\'s question first; add claims about other places, products or dates only when their own records state them.'

export const GUEST_FOCUS_BOUNDARY_RULE =
  'DATE BOUNDARIES: The computed_date_boundaries lines below restate closure and last-open dates that the named records state. Use them instead of re-deriving those boundaries; never describe a closure date as an open day.'

/**
 * Builds the focus block, or null when the visitor named no specific place or topic in this
 * message (or, for a follow-up that names none, in their previous message) and no retrieved
 * record states a date boundary.
 */
export function buildGuestFocusFacts(input: {
  question: string
  previousQuestion?: string | null
  knowledge: ReadonlyArray<GuestFocusKnowledge>
  places: ReadonlyArray<GuestFocusPlace>
  /** Records retrieval chose for this message; only their date boundaries are added. */
  retrieved?: ReadonlyArray<GuestFocusKnowledge>
  escape: (value: string) => string
  maxSubjects?: number
  maxChars?: number
}): GuestFocusFacts | null {
  const maxSubjects = input.maxSubjects ?? 4
  const maxChars = input.maxChars ?? 6_000
  let subjects = namedSubjects(input.question, input.knowledge, input.places)
  let fromPreviousQuestion = false
  if (!subjects.length && input.previousQuestion) {
    subjects = namedSubjects(input.previousQuestion, input.knowledge, input.places)
    fromPreviousQuestion = subjects.length > 0
  }
  const askedAttributes = guestFocusAskedAttributes(input.question)
  const blocks: string[] = []
  let used = 0
  let truncated = subjects.length > maxSubjects
  for (const subject of subjects.slice(0, maxSubjects)) {
    const text = subject.records.join('\n')
    const missing = askedAttributes.filter((attribute) => !statesAttribute(text, attribute))
    const notes = [
      ...guestFocusDateBoundaryNotes(text),
      ...(missing.length
        ? [
            `Not stated in its records: ${missing.map((attribute) => ATTRIBUTE_LABEL[attribute]).join('; ')}.`,
          ]
        : []),
    ]
    const name = input.escape(subject.name).replaceAll('"', "'")
    const computed = notes.length ? `\n<computed>${input.escape(notes.join(' '))}</computed>` : ''
    const block = `<focus_subject name="${name}">\n${input.escape(text)}${computed}\n</focus_subject>`
    if (blocks.length && used + block.length > maxChars) {
      truncated = true
      break
    }
    blocks.push(block)
    used += block.length
  }
  const focused = subjects.slice(0, blocks.length)
  const focusedKeys = new Set(focused.map((subject) => subject.key))
  const boundaryLines = new Set<string>()
  for (const entry of input.retrieved ?? []) {
    if (focusedKeys.has(guestPlaceIdentityKey(entry.title))) continue
    const notes = guestFocusDateBoundaryNotes(entry.content)
    if (notes.length) boundaryLines.add(`${entry.title}: ${notes.join(' ')}`)
  }
  const boundaries = [...boundaryLines].slice(0, 8)
  if (!blocks.length && !boundaries.length) return null
  const boundaryBlock = boundaries.length
    ? [
        `<computed_date_boundaries>\n${input.escape(boundaries.join('\n'))}\n</computed_date_boundaries>`,
      ]
    : []
  return {
    rule: [
      ...(blocks.length ? [GUEST_FOCUS_FACTS_RULE] : []),
      ...(boundaries.length ? [GUEST_FOCUS_BOUNDARY_RULE] : []),
    ].join('\n\n'),
    data: [...blocks, ...boundaryBlock].join('\n'),
    subjects: focused.map((subject) => subject.name),
    fromPreviousQuestion,
    askedAttributes,
    truncated,
  }
}
