// Evidence assembly: one bounded, per-turn packet of the current records a visitor's question is
// about, the policies that govern them, what is explicitly unknown, and who in the visitor's party
// each rule applies to. It also returns the next turn's continuity state: record references only,
// never assistant text.
//
// Why (2026-11-01 diagnostic, 262 Luna calls): governing records retrieved for a first question
// were absent from the follow-up, and raising reasoning did not recover them; restoring the actual
// records did (10/10). Same-name things of different kinds collapsed, a rule naming four animal
// experiences was generalized to a fifth, a rider's threshold was applied to the companion, and a
// pass's forfeiture was dropped when context was compacted. This module addresses each with a
// deterministic step and leaves explanation to the model.
//
// Inputs must already be authorized for this visitor and turn. Carried references are reloaded by
// the caller through the venue's authorization fence before they reach this function; anything
// that failed to reload arrives as `unavailableRefs` and is never rendered by name or content.

import { guestPlaceIdentityKey } from './guest-place-identity'
import {
  GUEST_FOCUS_ATTRIBUTE_LABEL,
  guestFocusAskedAttributes,
  guestFocusDateBoundaryNotes,
  guestFocusStatesAttribute,
} from './guest-focus-facts'
import {
  guestThingNames,
  guestThingPredicate,
  parseGuestRecordSemantics,
  type GuestFactClause,
  type GuestRecordSemantics,
  type GuestThingKind,
} from './guest-record-semantics'
import { guestAnswerShape, type GuestAnswerShapeResult } from './guest-answer-shape'
import { buildGuestVisitorParty, renderGuestVisitorParty } from './guest-conversation-party'

export const GUEST_EVIDENCE_ASSEMBLY_VERSION = 'guest-evidence-assembly-v3'

export type GuestEvidenceAssemblyMode = 'off' | 'on' | 'luna'

/** GUEST_CHAT_EVIDENCE_ASSEMBLY: "on" for every model, "luna" for Luna-family routes, else off. */
export function guestEvidenceAssemblyMode(
  env: Record<string, string | undefined> = process.env,
): GuestEvidenceAssemblyMode {
  const value = env.GUEST_CHAT_EVIDENCE_ASSEMBLY?.trim().toLowerCase()
  return value === 'on' || value === 'luna' ? value : 'off'
}

export function guestEvidenceAssemblyForModel(
  mode: GuestEvidenceAssemblyMode,
  primaryModelKey: string | null | undefined,
): boolean {
  if (mode === 'on') return true
  return mode === 'luna' && /^guest-chat-luna(?:-|$)/u.test(primaryModelKey ?? '')
}

/** One authorized record in a uniform shape. `ref` is "knowledge:<id>" or "place:<id>". */
export type GuestEvidenceRecord = {
  ref: string
  title: string
  content: string
  category?: string | null
  placeType?: string | null
  itemType?: string | null
  /** Content version used to detect a change between turns; null when not comparable. */
  version: string | null
}

export type GuestEvidenceStateRef = {
  ref: string
  version: string | null
  reason: 'subject' | 'governing' | 'scope'
  /** Turns since this ref was last selected for the current question. */
  age: number
}

export type GuestEvidenceState = {
  version: 'guest-evidence-state-v1'
  refs: GuestEvidenceStateRef[]
}

export type GuestRequiredNotice = {
  /** Authored, visitor-facing sentence (escaped only at render time, never here). */
  text: string
  /** Names whose mention in the answer makes the notice required. */
  names: string[]
  /** Context-only policy names removed locally before the subject mention gate. */
  mentionExcludingNames?: string[]
  ref: string
  /** An actionable question requires it without a name mention (own subject or its rule). */
  onAction?: boolean
  /** False for a narrow fact lookup; still required if the answer recommends this thing's use. */
  requiredForQuestion?: boolean
}

export type GuestEvidenceCoverage = {
  mode: 'FULL' | 'DIRECTORY' | 'NONE'
  incomplete: boolean
  retrievalPartial: boolean
  loadFailed: boolean
}

export type GuestEvidenceAssembly = {
  /** Instruction text; belongs outside the untrusted data fence. */
  rule: string
  /** Escaped data; belongs inside the untrusted data fence. */
  data: string
  state: GuestEvidenceState
  /** Names of each state ref, used only to choose which subjects the reply discussed. */
  refNames: Record<string, string[]>
  /** Transient confidence/dependency metadata; only ref IDs enter persisted state. */
  weakCandidateRefs?: Record<string, string[]>
  /** Authorized names for clause-level notice attribution; never persisted as continuity. */
  knownNames: string[]
  notices: GuestRequiredNotice[]
  /** The records rendered in the block, for answer-evidence provenance. */
  rendered: GuestEvidenceRecord[]
  /** Current records used only for scope/exclusion notes, not as applicable rules. */
  supporting: GuestEvidenceRecord[]
  trace: {
    version: typeof GUEST_EVIDENCE_ASSEMBLY_VERSION
    shape: GuestAnswerShapeResult['shape']
    subjects: number
    carriedSubjects: number
    governing: number
    ambiguities: number
    unknownScopes: number
    missingLinks: number
    unavailable: number
    changed: number
    persons: number
    topicChange: boolean
    truncated: boolean
    notices: number
  }
}

type Indexed = GuestEvidenceRecord & {
  semantics: GuestRecordSemantics
  names: string[]
  keys: string[]
}

type Thing = {
  name: string
  kind: GuestThingKind
  type: string | null
  /** Own records (same name and compatible kind). */
  records: Indexed[]
  /** A distinct thing named inside another record ("Comet wristband" in "Group outings"). */
  embeddedIn: Indexed | null
  /** How an embedded thing was found: a name plus a kind noun, or a labeled line with the name. */
  derived?: 'noun' | 'label'
  /** The embedded thing's own text (its labeled line), for matching the question's words. */
  embeddedText?: string
  origin: 'named' | 'partial-name' | 'identify-candidate' | 'carried'
}

type Included = {
  record: Indexed
  label: string
  origin: string
  /** Things this record is the own record of; empty for a governing-only record. */
  subjectOf: Thing[]
}

// One-word titles that name a topic rather than a thing a visitor asks about.
const GENERIC_NAMES = new Set([
  'hours',
  'tickets',
  'ticket',
  'parking',
  'rides',
  'food',
  'dining',
  'rules',
  'map',
  'faq',
  'about',
  'overview',
  'events',
  'shows',
  'animals',
  'exhibits',
  'policies',
  'accessibility',
  'restrooms',
  'lockers',
  'weather',
  'admission',
  'prices',
  'pricing',
  'directions',
  'contact',
  'safety',
  'attractions',
  'shopping',
  'membership',
  'groups',
])

// Words of an ordinary question that never identify a thing by themselves.
const COMMON_QUESTION_WORDS = new Set([
  'ride',
  'show',
  'open',
  'time',
  'much',
  'cost',
  'price',
  'take',
  'bring',
  'visit',
  'kid',
  'child',
  'children',
  'tell',
  'everything',
  'about',
  'what',
  'where',
  'when',
  'which',
  'there',
  'have',
  'does',
  'with',
  'that',
  'this',
  'they',
  'them',
  'need',
  'want',
  'like',
  'good',
  'best',
  'today',
  'tomorrow',
  'know',
  'more',
  'some',
  'allowed',
  'should',
  'could',
  'would',
  'inch',
  'year',
  'height',
  'tall',
  'old',
])

// Kind words an "all <kind>" scope covers. General across venue types; deliberately small.
const KIND_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  ride: ['ride', 'coaster', 'slide', 'carousel', 'flume', 'swing', 'drop tower', 'dark ride', 'water ride'],
  attraction: ['attraction', 'ride', 'coaster', 'slide', 'exhibit', 'show', 'habitat', 'theater'],
  gallery: ['gallery', 'exhibit', 'exhibition', 'hall', 'room'],
  exhibit: ['exhibit', 'exhibition', 'gallery', 'habitat', 'hall'],
  experience: ['experience', 'encounter', 'feeding', 'keeper chat', 'tour', 'session'],
  tour: ['tour', 'guided walk'],
  show: ['show', 'performance', 'presentation'],
  restaurant: ['restaurant', 'cafe', 'café', 'grill', 'kitchen', 'dining', 'snack'],
  slide: ['slide', 'flume'],
}

// A noun right after a thing's name makes a different thing that shares the name.
const DERIVED_THING_NOUN: ReadonlyArray<[RegExp, GuestThingKind, string]> = [
  [/^(?:wristbands?|tickets?|pass(?:es)?|packages?|plans?|deals?|memberships?|vouchers?|combos?|bundles?|upgrades?)$/u, 'ITEM', 'offer'],
  [/^(?:experiences?|encounters?|tours?|feedings?|talks?|sessions?|classes?|workshops?)$/u, 'SERVICE', 'experience'],
  [/^(?:shows?|parades?|festivals?|nights?|concerts?|performances?)$/u, 'EVENT', 'event'],
  [/^(?:cafe|café|grill|kitchen|bar|restaurant|snacks?|stand|kiosk|cart|truck|counter|bakery|shop|store|gifts?)$/u, 'PLACE', 'dining or shop'],
]

// Question words that point at one kind of thing.
const KIND_CUES: ReadonlyArray<[GuestThingKind, RegExp]> = [
  ['ITEM', /\b(?:how much|price|prices|cost|costs|buy|purchase|ticket|tickets|pass|wristband|deal|discount|package|pay|fee)\b/iu],
  ['PLACE', /\b(?:ride|rides|riding|tall|height|inches|where is|where's|located|scary|fast|drop|loop|line|wait|go on|get on|sit|seat)\b/iu],
  ['EVENT', /\b(?:when is|what time|showtimes?|schedule|tonight|starts?|performance)\b/iu],
  ['SERVICE', /\b(?:book|booking|reserve|reservation|sign up|session|feed|feeding|meet)\b/iu],
]

const REFERRING =
  /\b(?:it|its|it's|that|this|those|these|they|them|their|there|he|she|him|her|his|same|also|too|either|both|instead|what about|how about|and for|and if|and what|then)\b/iu

const IDENTIFY_NOUN =
  /\b(coaster|ride|animal|bird|building|tower|statue|sculpture|painting|show|exhibit|slide|train|boat|wheel|fountain|tree|plane|car|truck|ship|dinosaur|fish|monkey|cat|bear|snake)s?\b/iu

const RULE = `EVIDENCE FOCUS: The <evidence_focus> block was assembled for this question from current venue records, reloaded this turn. Where the VENUE GUIDE shows a different version of the same record, this version is current. Earlier replies in this conversation are not evidence: where they differ from these records, the records win. Each <thing> holds one thing's own records; its facts belong to that thing only. A probable partial-name match or identification candidate is not a confirmed subject: do not attach its use notices merely because the visitor asks an actionable question; require supported identification and actual discussion of that thing. Use a rule's requirements only for targets supported by its current scope or governing links. An unlisted target is not thereby exempt: applicability remains unknown unless current records establish inclusion or exclusion. An evidence note marked unknown stays unknown: never turn it into allowed, not allowed, free, included, required or absent. When an identity note names more than one candidate, answer for the one the question clearly means and name it, or ask one short question. visitor_party lines give each person's own height and age: compare a rule only with the person in the role that rule names (rider, companion, rider alone), never with another person. A must_mention line supplies an authored visitor notice. Follow NOTICE RELEVANCE to decide when it belongs in the answer; when required, say it in your own words or as written.`

function singular(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`
  if (word.length > 3 && word.endsWith('es') && /(?:ches|shes|sses|xes)$/u.test(word)) return word.slice(0, -2)
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1)
  return word
}

function phraseIn(haystackKey: string, phraseKey: string): boolean {
  if (phraseKey.length < 3) return false
  const hay = ` ${haystackKey} `
  return (
    hay.includes(` ${phraseKey} `) ||
    hay.includes(` ${phraseKey}s `) ||
    (phraseKey.endsWith('s') && hay.includes(` ${phraseKey.slice(0, -1)} `))
  )
}

function isSpecific(key: string): boolean {
  if (GENERIC_NAMES.has(key)) return false
  return key.includes(' ') || key.length >= 4
}

function indexRecord(record: GuestEvidenceRecord): Indexed {
  const semantics = parseGuestRecordSemantics({
    title: record.title,
    content: record.content,
    category: record.category ?? null,
    ...(record.placeType !== undefined ? { placeType: record.placeType } : {}),
    ...(record.itemType !== undefined ? { itemType: record.itemType } : {}),
  })
  const names = guestThingNames(record.title, semantics)
  return { ...record, semantics, names, keys: names.map(guestPlaceIdentityKey) }
}

function kindLabel(thing: { kind: GuestThingKind; type: string | null }): string {
  if (thing.type) return thing.type
  return thing.kind === 'ITEM' ? 'item or offer' : thing.kind.toLocaleLowerCase()
}

/** Distinct kinds count as different things; an inferred KNOWLEDGE kind is compatible with any. */
function compatibleKinds(left: Indexed, right: Indexed): boolean {
  const a = left.semantics
  const b = right.semantics
  if (a.kind === b.kind) return true
  if (a.kindSource === 'inferred' && a.kind === 'KNOWLEDGE') return true
  if (b.kindSource === 'inferred' && b.kind === 'KNOWLEDGE') return true
  // A place and a knowledge topic about it ("Rides" category) are the same thing.
  if ((a.kind === 'PLACE' && b.kindSource === 'inferred') || (b.kind === 'PLACE' && a.kindSource === 'inferred'))
    return a.kind === 'PLACE' ? b.kind !== 'ITEM' && b.kind !== 'POLICY' : a.kind !== 'ITEM' && a.kind !== 'POLICY'
  return false
}

function groupThings(records: Indexed[], key: string, origin: Thing['origin']): Thing[] {
  const things: Thing[] = []
  for (const record of records) {
    const existing = things.find((thing) => thing.records.every((other) => compatibleKinds(other, record)))
    if (existing) {
      existing.records.push(record)
      // A stated kind wins over an inferred one for the merged thing's label.
      if (record.semantics.kindSource !== 'inferred') {
        existing.kind = record.semantics.kind
        existing.type = record.semantics.type
      }
      continue
    }
    things.push({
      name: record.names.find((name) => guestPlaceIdentityKey(name) === key) ?? record.title,
      kind: record.semantics.kind,
      type: record.semantics.type,
      records: [record],
      embeddedIn: null,
      origin,
    })
  }
  return things
}

/**
 * Different things that share a name, found inside other records: an existing name followed by a
 * kind noun ("Comet wristband"), or a labeled line whose label is the name ("Lantern Court: a
 * seasonal cafe kiosk ...").
 */
function embeddedThings(nameKey: string, displayName: string, records: Indexed[]): Thing[] {
  const things: Thing[] = []
  for (const record of records) {
    if (record.keys.includes(nameKey)) continue
    // "Lantern Court: a seasonal café kiosk beside the courtyard" inside a dining topic.
    for (const fact of record.semantics.facts) {
      if (guestPlaceIdentityKey(fact.label) !== nameKey) continue
      const type = guestThingPredicate(`${displayName} is ${/^(?:a|an|the)\b/iu.test(fact.value) ? '' : 'a '}${fact.value}`)
      const kind =
        DERIVED_THING_NOUN.find(([pattern]) => (type ?? '').split(' ').some((word) => pattern.test(guestPlaceIdentityKey(word))))?.[1] ??
        'KNOWLEDGE'
      things.push({
        name: displayName,
        kind,
        type,
        records: [],
        embeddedIn: record,
        derived: 'label',
        embeddedText: fact.value,
        origin: 'named',
      })
    }
    const contentKey = guestPlaceIdentityKey(record.content)
    let index = ` ${contentKey} `.indexOf(` ${nameKey} `)
    while (index >= 0) {
      // The kind noun may follow directly ("Comet wristband") or after one word ("Riptide Group
      // Package"); the derived name keeps every word up to the noun.
      const next = contentKey.slice(index + nameKey.length).trim().split(' ').slice(0, 2)
      const nounAt = next.findIndex((word) => DERIVED_THING_NOUN.some(([pattern]) => pattern.test(word)))
      const after = nounAt >= 0 ? next.slice(0, nounAt + 1).join(' ') : ''
      const noun = nounAt >= 0 ? next[nounAt]! : ''
      for (const [pattern, kind, type] of DERIVED_THING_NOUN)
        if (noun && pattern.test(noun)) {
          const derivedKey = `${nameKey} ${after}`
          const original = record.content.match(new RegExp(String.raw`${displayName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\s+(\S+(?:\s+\S+)?)`, 'iu'))
          const shown = original && guestPlaceIdentityKey(original[1]!) === after ? original[1]!.replace(/[:;,.]$/u, '') : after
          if (!things.some((thing) => guestPlaceIdentityKey(thing.name) === derivedKey))
            things.push({
              name: `${displayName} ${shown}`,
              kind,
              type,
              records: [],
              embeddedIn: record,
              derived: 'noun',
              origin: 'named',
            })
        }
      index = ` ${contentKey} `.indexOf(` ${nameKey} `, index + 1)
    }
  }
  return things
}

function questionKindCue(question: string): GuestThingKind[] {
  return KIND_CUES.filter(([, pattern]) => pattern.test(question)).map(([kind]) => kind)
}

type Identity = {
  name: string
  candidates: Thing[]
  chosen: Thing | null
}

function resolveSubjects(question: string, indexed: Indexed[]): { things: Thing[]; identities: Identity[] } {
  const questionKey = guestPlaceIdentityKey(question)
  const byKey = new Map<string, Indexed[]>()
  for (const record of indexed)
    for (const key of record.keys)
      if (isSpecific(key) && phraseIn(questionKey, key)) {
        const list = byKey.get(key) ?? []
        if (!list.includes(record)) list.push(record)
        byKey.set(key, list)
      }
  // A name inside a longer matched name ("Comet" in "Comet Jr") is the same mention.
  const keys = [...byKey.keys()].sort((left, right) => right.length - left.length)
  const kept = keys.filter((key, index) => !keys.slice(0, index).some((longer) => phraseIn(longer, key)))
  const cues = questionKindCue(question)
  const things: Thing[] = []
  const identities: Identity[] = []
  for (const key of kept) {
    const records = byKey.get(key)!
    const display = records[0]!.names.find((name) => guestPlaceIdentityKey(name) === key) ?? records[0]!.title
    const titled = groupThings(records, key, 'named')
    const embedded = embeddedThings(key, display, indexed)
    // When the question spells out the derived thing ("Comet wristband"), it is the subject.
    const spelled = embedded.filter(
      (thing) => thing.derived === 'noun' && phraseIn(questionKey, guestPlaceIdentityKey(thing.name)),
    )
    const candidates = spelled.length ? [...spelled, ...titled] : [...titled, ...embedded]
    if (candidates.length === 1) {
      things.push(candidates[0]!)
      continue
    }
    // The visitor spelled out the derived thing: it is the subject. The same-name thing is named
    // in the note only, so its facts cannot attach to the subject.
    if (spelled.length === 1) {
      identities.push({ name: display, candidates, chosen: spelled[0]! })
      things.push(spelled[0]!)
      continue
    }
    let chosen: Thing | null = null
    const cued = cues.length ? candidates.filter((thing) => cues.includes(thing.kind)) : []
    // The question's other words ("open for hot cocoa") that only one candidate's own text has.
    const otherWords = (questionKey.match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length >= 4 && !key.split(' ').includes(word) && !COMMON_QUESTION_WORDS.has(singular(word)))
      .map(singular)
    const ownText = (thing: Thing) =>
      guestPlaceIdentityKey(thing.embeddedText ?? thing.records.map((record) => record.content).join(' '))
    const wordScores = candidates.map((thing) => otherWords.filter((word) => phraseIn(ownText(thing), word)).length)
    const best = Math.max(0, ...wordScores)
    const bestCandidates = candidates.filter((_, index) => wordScores[index] === best)
    if (best > 0 && bestCandidates.length === 1) chosen = bestCandidates[0]!
    // A kind cue alone ("how much is Riptide?") is weak: a ride's price is usually admission. It
    // may pick among titled things, but never promotes a thing mentioned inside another record over
    // the titled one; that stays ambiguous so the answer covers both or asks.
    else if (cued.length === 1 && new Set(candidates.map((thing) => thing.kind)).size > 1) {
      if (!cued[0]!.embeddedIn) chosen = cued[0]!
    }
    // A bare name defaults to the thing titled with it, unless the wording points elsewhere.
    else if (titled.length === 1 && !cued.some((thing) => thing !== titled[0])) chosen = titled[0]!
    identities.push({ name: display, candidates, chosen })
    // Every candidate's records join the packet so the model can tell them apart; ambiguity is
    // stated, not resolved by dropping a candidate.
    things.push(...candidates)
  }
  return { things, identities }
}

function partialSubjects(question: string, indexed: Indexed[], retrievedOrder: Map<string, number>): Thing[] {
  const tokens = (guestPlaceIdentityKey(question).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(
      (token) =>
        token.length >= 4 &&
        !GENERIC_NAMES.has(token) &&
        !GENERIC_NAMES.has(singular(token)) &&
        !COMMON_QUESTION_WORDS.has(singular(token)),
    )
    .map(singular)
  if (!tokens.length) return []
  const matches = indexed
    .filter((record) =>
      record.keys.some((key) => key.split(' ').some((part) => tokens.includes(singular(part)))),
    )
    .sort((left, right) => (retrievedOrder.get(left.ref) ?? 999) - (retrievedOrder.get(right.ref) ?? 999))
    .slice(0, 2)
  return matches.map((record) => ({
    name: record.title,
    kind: record.semantics.kind,
    type: record.semantics.type,
    records: [record],
    embeddedIn: null,
    origin: 'partial-name' as const,
  }))
}

function identifyCandidates(
  question: string,
  shape: GuestAnswerShapeResult,
  indexed: Indexed[],
  retrievedOrder: Map<string, number>,
): { things: Thing[]; note: string | null } {
  // Something a visitor can see: a policy, offer or event is never what "that" points at.
  const visible = indexed.filter(
    (record) =>
      record.semantics.kind !== 'POLICY' &&
      record.semantics.kind !== 'EVENT' &&
      !(record.semantics.kind === 'ITEM' && /\b(?:offer|ticket|pass|membership|package|admission)\b/iu.test(record.semantics.type ?? '')),
  )
  const matched = question.match(IDENTIFY_NOUN)?.[1]?.toLocaleLowerCase()
  const nounKey = matched ? singular(matched) : null
  const byNoun = nounKey
    ? visible.filter((record) => {
        const text = guestPlaceIdentityKey(
          [record.title, record.semantics.type ?? '', record.content.split(/[.\n]/u)[0] ?? ''].join(' '),
        )
        return phraseIn(text, nounKey)
      })
    : []
  // No record uses the visitor's word ("building" for a conservatory): rank by the description.
  const questionWords = (guestPlaceIdentityKey(question).match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => token.length >= 4 && !COMMON_QUESTION_WORDS.has(singular(token)) && !GENERIC_NAMES.has(token))
    .map(singular)
  const overlap = (record: Indexed) => {
    const text = guestPlaceIdentityKey(`${record.title} ${record.content}`)
    return questionWords.filter((word) => word !== nounKey && phraseIn(text, word)).length
  }
  const ofKind = byNoun.length ? byNoun : visible.filter((record) => overlap(record) >= 2)
  const noun = matched ?? 'thing'
  if (!ofKind.length)
    return { things: [], note: `identification: no record matches the visitor's description; say so briefly and ask what they can see nearby, never guess.` }
  const descriptors = shape.descriptors
  const support = (record: Indexed) =>
    descriptors.filter((word) => phraseIn(guestPlaceIdentityKey(record.content), guestPlaceIdentityKey(word))).length +
    (byNoun.length ? 0 : overlap(record))
  const ranked = [...ofKind].sort(
    (left, right) =>
      support(right) - support(left) ||
      (retrievedOrder.get(left.ref) ?? 999) - (retrievedOrder.get(right.ref) ?? 999),
  )
  // A record about another candidate ("Thunder Run history") is not a separate thing to pick.
  const about = (record: Indexed) =>
    ofKind.some((other) => other !== record && other.keys.some((key) => isSpecific(key) && key !== record.keys[0] && phraseIn(record.keys[0] ?? '', key)))
  const distinct = ranked.filter((record) => !about(record))
  const supported = distinct.filter((record) => support(record) > 0)
  const chosen = (supported.length ? supported : distinct).slice(0, 3)
  const things = chosen.map((record) => ({
    name: record.title,
    kind: record.semantics.kind,
    type: record.semantics.type,
    records: [record],
    embeddedIn: null,
    origin: 'identify-candidate' as const,
  }))
  const unstated = descriptors.filter(
    (word) => !ofKind.some((record) => phraseIn(guestPlaceIdentityKey(record.content), guestPlaceIdentityKey(word))),
  )
  const parts: string[] = []
  if (!byNoun.length && matched)
    parts.push(`No record calls anything a ${matched}; the candidates below match other words of the description.`)
  if (descriptors.length)
    parts.push(
      supported.length
        ? `identification: the visitor's description (${descriptors.join(', ')}) is stated in the records of: ${supported
            .slice(0, 3)
            .map((record) => record.title)
            .join('; ')}.`
        : `identification: no ${noun} record states the visitor's description (${descriptors.join(', ')}); the candidates below are unconfirmed.`,
    )
  if (unstated.length && supported.length)
    parts.push(`No ${noun} record states: ${unstated.join(', ')}; treat that part of the description as unconfirmed.`)
  if (distinct.length > chosen.length)
    parts.push(`${distinct.length} records describe a ${noun}; only the closest ${chosen.length} are shown.`)
  return { things, note: parts.join(' ') || null }
}

function scopeTargetMatches(target: string, thing: Thing, namedTargets: ReadonlySet<string>): boolean {
  const targetKey = guestPlaceIdentityKey(target)
  const names = thing.records.length
    ? thing.records.flatMap((record) => record.keys)
    : [guestPlaceIdentityKey(thing.name)]
  if (names.some((key) => key === targetKey || singular(key) === singular(targetKey))) return true
  // A named record such as "Wings" is not a plural category for every wings exhibit.
  if (namedTargets.has(targetKey)) return false
  // "all coasters", "every animal experience", "rides": a kind phrase.
  const kindPhrase = targetKey.replace(/^(?:all|every|any|each)\s+(?:the\s+)?/u, '')
  if (kindPhrase === targetKey && !/^(?:all|every|any|each)\b/u.test(targetKey)) {
    // A bare plural ("rides") counts as a kind phrase only when it is not some thing's name.
    if (!targetKey.endsWith('s')) return false
  }
  const kindKey = singular(kindPhrase)
  // What the thing is (its stated or first-sentence kind and its category), never every word of
  // its description: "closes most rides" does not make a weather pass a ride.
  const descriptor = guestPlaceIdentityKey(
    [thing.type ?? '', ...thing.records.map((record) => `${record.category ?? ''} ${record.semantics.type ?? ''}`)].join(' '),
  )
  if (kindKey.length < 3) return false
  if (phraseIn(descriptor, kindKey) || phraseIn(descriptor, kindPhrase)) return true
  // "all rides" covers a coaster; "all galleries" covers an exhibit hall. Only the author's
  // explicit all-of-a-kind scope widens this way; a list of named things never does.
  const words = kindKey.split(' ')
  const head = words.at(-1)!
  const qualifiers = words.slice(0, -1)
  const members = KIND_MEMBERS[head]
  return Boolean(
    members &&
      members.some((member) => phraseIn(descriptor, member)) &&
      qualifiers.every((qualifier) => phraseIn(descriptor, qualifier)),
  )
}

type GoverningLink = { record: Indexed; subject: Thing; because: string }

function governingFor(thing: Thing, indexed: Indexed[], namedTargets: ReadonlySet<string>): {
  links: GoverningLink[]
  excluded: Array<{ record: Indexed; subject: Thing; conflict: boolean }>
  unknownScopes: string[]
  missingLinks: string[]
  scopeRecords: Indexed[]
} {
  const own = new Set([...thing.records, ...(thing.embeddedIn ? [thing.embeddedIn] : [])])
  const links: GoverningLink[] = []
  const excluded: Array<{ record: Indexed; subject: Thing; conflict: boolean }> = []
  const unknownScopes: string[] = []
  const missingLinks: string[] = []
  const scopeRecords: Indexed[] = []
  const names = thing.records.length ? thing.records.flatMap((record) => record.keys) : [guestPlaceIdentityKey(thing.name)]
  for (const record of indexed) {
    if (own.has(record)) continue
    const scope = record.semantics.scope
    if (scope.doesNotApplyTo.some((target) => scopeTargetMatches(target, thing, namedTargets))) {
      const exactIncluded = scope.appliesTo.some((target) => names.includes(guestPlaceIdentityKey(target)))
      const linkedAsGoverning = thing.records.some((subject) => subject.semantics.links.some((link) =>
        link.relation === 'governed-by' && record.keys.includes(guestPlaceIdentityKey(link.target))))
      excluded.push({ record, subject: thing, conflict: exactIncluded || linkedAsGoverning })
      scopeRecords.push(record)
      continue
    }
    const scoped = scope.appliesTo.find((target) => scopeTargetMatches(target, thing, namedTargets))
    // A product or event can apply at this place without governing participation
    // there. Only policies establish authority from scope alone; an explicit
    // Governed by link below can still name any authored record kind.
    if (scoped && record.semantics.kind === 'POLICY') {
      links.push({ record, subject: thing, because: `its Applies to line names "${scoped}"` })
      continue
    }
    // A policy that names the thing in its text governs it, unless its scope list says otherwise.
    const contentKey = guestPlaceIdentityKey(record.content)
    if (
      record.semantics.kind === 'POLICY' &&
      !scope.appliesTo.length &&
      names.some((key) => isSpecific(key) && phraseIn(contentKey, key))
    ) {
      links.push({ record, subject: thing, because: 'it names this thing' })
      continue
    }
    // A scope list of named peers that leaves this thing out: unknown, never "applies" or "not".
    const named = scope.appliesTo.filter((target) => !/^(?:all|every|any|each)\b/iu.test(target))
    if (named.length >= 2 && thing.records.length) {
      const peers = named
        .map((target) => indexed.find((other) => other.keys.includes(guestPlaceIdentityKey(target))))
        .filter((peer): peer is Indexed => Boolean(peer))
      const thingType = guestPlaceIdentityKey(thing.records[0]!.semantics.type ?? thing.records[0]!.category ?? '')
      const sameType =
        thingType.length >= 3 &&
        peers.length >= 2 &&
        peers.every((peer) => guestPlaceIdentityKey(peer.semantics.type ?? peer.category ?? '') === thingType)
      if (sameType) {
        scopeRecords.push(record)
        unknownScopes.push(
          `"${record.title}" applies to ${named.join('; ')}. It does not say whether it applies to ${thing.name}: that is unknown, not a yes or a no.`,
        )
      }
    }
  }
  for (const record of thing.records)
    for (const link of record.semantics.links) {
      if (link.relation !== 'governed-by') continue
      const target = indexed.find((other) => other.keys.includes(guestPlaceIdentityKey(link.target)))
      if (target && !own.has(target)) {
        if (target.semantics.scope.doesNotApplyTo.some((scope) => scopeTargetMatches(scope, thing, namedTargets))) {
          missingLinks.push(`${record.title} names "${target.title}" as its governing policy, but that policy explicitly excludes ${thing.name}. These records conflict about applicability; do not resolve the conflict by granting or denying permission.`)
          continue
        }
        if (!links.some((existing) => existing.record === target))
          links.push({ record: target, subject: thing, because: `${record.title} is governed by it` })
      } else if (!target && link.relation === 'governed-by')
        missingLinks.push(
          `${thing.name} is governed by "${link.target}", which is not available now: its rules are unknown. Do not treat them as allowing or forbidding anything.`,
        )
    }
  return { links, excluded, unknownScopes, missingLinks, scopeRecords }
}

function roleLabel(clause: GuestFactClause): string | null {
  switch (clause.role) {
    case 'accompanied':
      return 'with a companion or adult'
    case 'alone':
      return 'alone or unaccompanied'
    case 'companion':
      return 'companion'
    case 'adult':
      return 'adult'
    case 'child':
      return 'child'
    case 'senior':
      return 'senior'
    case 'member':
      return 'member'
    case 'group':
      return 'group'
    default:
      return null
  }
}

/** Structural lines for one record. Tags are literal; every value inside them is escaped. */
function factLines(
  record: Indexed,
  askedAttributes: ReturnType<typeof guestFocusAskedAttributes>,
  subject: boolean,
  escape: (value: string) => string,
): string[] {
  const semantics = record.semantics
  const lines: string[] = []
  const tag = (name: string, value: string) => `<${name}>${escape(value)}</${name}>`
  for (const fact of semantics.facts) {
    // Only clauses with one unambiguous number and an explicit role become role lines.
    const roles = fact.clauses
      .map((clause) => {
        const role = roleLabel(clause)
        // A negative or unknown clause cannot be simplified into a positive eligibility
        // threshold. Its authored wording remains in the full record above.
        if (!role || !clause.quantity || clause.negative || clause.unknown ||
          /\b(?:if|unless|except|when|until|provided|only|should|recommended?|optional|may|might)\b/iu.test(clause.text)) return null
        const bound = clause.quantity.bound === 'max'
          ? /\b(?:under|below)\s+\d/iu.test(clause.text) ? 'under ' : 'at most '
          : clause.quantity.bound === 'min' ? 'at least ' : ''
        const unit = clause.quantity.unit === 'usd' ? 'USD' : clause.quantity.unit
        return `${role}: ${bound}${clause.quantity.value} ${unit}${clause.unknown ? ' (stated as not known)' : ''}`
      })
      .filter((line): line is string => Boolean(line))
    if (roles.length) lines.push(`<roles fact="${escape(attr(fact.label))}">${escape(roles.join('; '))}</roles>`)
  }
  if (semantics.scope.appliesTo.length) lines.push(tag('applies_to', semantics.scope.appliesTo.join('; ')))
  if (semantics.scope.doesNotApplyTo.length) lines.push(tag('does_not_apply_to', semantics.scope.doesNotApplyTo.join('; ')))
  for (const condition of semantics.conditions) lines.push(tag('condition', condition))
  for (const exception of semantics.exceptions) lines.push(tag('exception', exception))
  const consequences = semantics.consequences.length ? semantics.consequences : semantics.materialSentences
  for (const consequence of consequences) lines.push(tag('consequence', consequence))
  for (const notice of semantics.mustMention) lines.push(tag('must_mention', notice))
  for (const unknown of semantics.unknowns) lines.push(tag('unknown', unknown))
  if (semantics.effective) lines.push(tag('effective', semantics.effective))
  if (subject) {
    const missing = askedAttributes.filter((attribute) => !guestFocusStatesAttribute(record.content, attribute))
    if (missing.length)
      lines.push(
        tag('not_stated', `${missing.map((attribute) => GUEST_FOCUS_ATTRIBUTE_LABEL[attribute]).join('; ')} (unknown, not absent)`),
      )
  }
  const boundaries = guestFocusDateBoundaryNotes(record.content)
  if (boundaries.length) lines.push(tag('date_boundaries', boundaries.join(' ')))
  return lines
}

function attr(value: string): string {
  return value.replaceAll('"', "'")
}

export function assembleGuestEvidence(input: {
  question: string
  /** The visitor's own messages, oldest first, ending with the current question. */
  visitorMessages: ReadonlyArray<string>
  shape: GuestAnswerShapeResult
  /** Every authorized current record (directory, retrieved, reloaded); later entries win by ref. */
  records: ReadonlyArray<GuestEvidenceRecord>
  /** Refs in current retrieval order, best first. */
  retrievedRefs: ReadonlyArray<string>
  previous: GuestEvidenceState | null
  /** Carried refs that failed reauthorization or reload this turn. */
  unavailableRefs: ReadonlyArray<string>
  coverage: GuestEvidenceCoverage
  escape: (value: string) => string
  maxRecords?: number
  maxChars?: number
}): GuestEvidenceAssembly {
  const maxRecords = input.maxRecords ?? 10
  const maxChars = input.maxChars ?? 16_000
  const byRef = new Map<string, Indexed>()
  const unavailable = new Set(input.unavailableRefs)
  for (const record of input.records) if (!unavailable.has(record.ref)) byRef.set(record.ref, indexRecord(record))
  const indexed = [...byRef.values()]
  const namedTargets = new Set(indexed.flatMap((record) => record.keys))
  const retrievedOrder = new Map(input.retrievedRefs.map((ref, index) => [ref, index]))
  const askedAttributes = guestFocusAskedAttributes(input.question)
  const notes: string[] = []

  // 1. Subjects of the current question.
  const resolved = resolveSubjects(input.question, indexed)
  const identities = resolved.identities
  let subjects = resolved.things
  if (!subjects.length && input.shape.shape === 'IDENTIFY') {
    const identify = identifyCandidates(input.question, input.shape, indexed, retrievedOrder)
    subjects = identify.things
    if (identify.note) notes.push(identify.note)
  } else if (input.shape.shape === 'IDENTIFY' && input.shape.descriptors.length) {
    const unstated = input.shape.descriptors.filter(
      (word) =>
        !subjects.some((thing) =>
          thing.records.some((record) => phraseIn(guestPlaceIdentityKey(record.content), guestPlaceIdentityKey(word))),
        ),
    )
    if (unstated.length)
      notes.push(`identification: no record of the named thing states: ${unstated.join(', ')}; treat that description as unconfirmed.`)
  }
  // 2. Continuity: carry previous subjects when the question refers back; drop them on a new topic.
  const previousRefs = input.previous?.refs ?? []
  const referring = REFERRING.test(input.question)
  // A question that names no new thing keeps the earlier subject ("Can my neighbor take the
  // 7-year-old up?"); losing a governing record was the measured failure, while a carried record
  // is labeled and fades. Naming a new thing is a topic change unless the question refers back.
  const carry = previousRefs.length > 0 && (subjects.length ? referring : true)
  // A partial name ("the pandas" for "Red Panda Ridge") is a fallback for a fresh question only;
  // a follow-up that refers back keeps its earlier subject instead.
  if (!subjects.length && !carry && (input.shape.shape === 'DEEP_DIVE' || input.shape.shape === 'FACT'))
    subjects = partialSubjects(input.question, indexed, retrievedOrder)
  const topicChange = previousRefs.length > 0 && !carry
  const carriedSubjects: Thing[] = []
  const carriedGoverning: Indexed[] = []
  if (carry) {
    const subjectRefs = new Set(subjects.flatMap((thing) => thing.records.map((record) => record.ref)))
    for (const ref of previousRefs) {
      if (ref.age >= 2) continue
      const record = byRef.get(ref.ref)
      if (!record || subjectRefs.has(record.ref)) continue
      if (ref.reason === 'subject')
        carriedSubjects.push({
          name: record.title,
          kind: record.semantics.kind,
          type: record.semantics.type,
          records: [record],
          embeddedIn: null,
          origin: 'carried',
        })
      else if (ref.reason === 'governing') carriedGoverning.push(record)
    }
  }
  const unavailableCarried = previousRefs.filter((ref) => unavailable.has(ref.ref) || !byRef.has(ref.ref))
  if (unavailableCarried.length)
    notes.push(
      `${unavailableCarried.length === 1 ? 'A record' : `${unavailableCarried.length} records`} used earlier in this conversation ${unavailableCarried.length === 1 ? 'is' : 'are'} no longer available. Anything said earlier from ${unavailableCarried.length === 1 ? 'it' : 'them'} is no longer supported: treat it as unknown and do not repeat it.`,
    )
  const changed = previousRefs.filter((ref) => {
    const record = byRef.get(ref.ref)
    return record && ref.version !== null && record.version !== null && record.version !== ref.version
  })
  for (const ref of changed)
    notes.push(`"${byRef.get(ref.ref)!.title}" has changed since it was used earlier in this conversation; use only the current version below.`)

  // 3. Governing records, unknown scope and missing links for every subject.
  const allSubjects = [...subjects, ...carriedSubjects]
  const governing: GoverningLink[] = []
  const excludedNotes = new Set<string>()
  const unknownScopes = new Set<string>()
  const missingLinks = new Set<string>()
  const scopeRecords = new Map<Indexed, Thing[]>()
  for (const thing of allSubjects) {
    const found = governingFor(thing, indexed, namedTargets)
    for (const record of found.scopeRecords) scopeRecords.set(record, [...(scopeRecords.get(record) ?? []), thing])
    for (const link of found.links) if (!governing.some((existing) => existing.record === link.record && existing.subject === thing)) governing.push(link)
    for (const { record, subject, conflict } of found.excluded)
      excludedNotes.add(
        conflict
          ? `scope conflict: "${record.title}" excludes ${subject.name}, but an exact Applies to target or Governed by link also includes it. Applicability is disputed by the current records; do not assert either confirmed applicability or a confirmed exemption. Ask the venue to resolve this conflict.`
          : `"${record.title}" says it does not apply to ${subject.name}. This is a confirmed exemption from this particular policy, not uncertainty about whether this policy applies. Do not transfer its requirements or permissions to ${subject.name}. The exemption alone does not establish what other policies allow or require. Keep independent applicable requirements from this subject and its other governing policies; an exemption from one rule does not waive them.`,
      )
    for (const scope of found.unknownScopes) unknownScopes.add(scope)
    for (const missing of found.missingLinks) missingLinks.add(missing)
  }
  // A policy explicitly asked about (or reloaded from the referring turn's
  // scope/rule context) remains a live question even when the new target has a
  // different kind. Do not scan unrelated policies or infer a closed-world scope.
  const contextualPolicies = new Set(allSubjects.flatMap((thing) => thing.records)
    .filter((record) => record.semantics.kind === 'POLICY'))
  if (carry) for (const ref of previousRefs) {
    if (ref.age >= 2 || (ref.reason !== 'scope' && ref.reason !== 'governing')) continue
    const record = byRef.get(ref.ref)
    if (record?.semantics.kind === 'POLICY') contextualPolicies.add(record)
  }
  for (const record of contextualPolicies) {
    if (!record.semantics.scope.appliesTo.length) continue
    for (const thing of subjects) {
      if (thing.records.includes(record) || thing.kind === 'POLICY') continue
      if (governing.some((link) => link.record === record && link.subject === thing)) continue
      if (record.semantics.scope.doesNotApplyTo.some((target) => scopeTargetMatches(target, thing, namedTargets))) continue
      unknownScopes.add(`"${record.title}" names ${record.semantics.scope.appliesTo.join('; ')} as applicable targets, but current records do not establish whether it applies to ${thing.name}. Applicability is unknown, not a confirmed exemption or a confirmed requirement.`)
      scopeRecords.set(record, [...(scopeRecords.get(record) ?? []), thing])
    }
  }
  // Reloading a carried rule also means recomputing its relationship. A rule can have
  // changed scope since the previous turn; continuity must not resurrect that old binding.
  if (allSubjects.length) {
    for (let index = carriedGoverning.length - 1; index >= 0; index -= 1) {
      const record = carriedGoverning[index]!
      if (!governing.some((link) => link.record === record)) carriedGoverning.splice(index, 1)
    }
  }
  // Retrieved rules for a permission or action question that has no subject at all ("Can I bring
  // my dog?"). With a subject, an unrelated retrieved policy presented as its rule is a binding
  // risk of its own (2026-11-01 paid run: a tour rule's notice was attached to a membership answer).
  if (
    (input.shape.permission || input.shape.actionable) &&
    !allSubjects.length &&
    !governing.length &&
    !carriedGoverning.length
  ) {
    const retrievedPolicies = input.retrievedRefs
      .map((ref) => byRef.get(ref))
      .filter((record): record is Indexed => Boolean(record) && record!.semantics.kind === 'POLICY')
      .slice(0, 2)
    for (const record of retrievedPolicies)
      if (
        !governing.some((link) => link.record === record) &&
        !allSubjects.some((thing) => thing.records.includes(record)) &&
        // A rule that excludes this question's subject is not its rule.
        !allSubjects.some((thing) => record.semantics.scope.doesNotApplyTo.some((target) => scopeTargetMatches(target, thing, namedTargets)))
      )
        governing.push({
          record,
          subject: allSubjects[0] ?? { name: 'this question', kind: 'KNOWLEDGE', type: null, records: [], embeddedIn: null, origin: 'named' },
          because: 'retrieved as possibly relevant; it applies only to what it names',
        })
  }

  // 4. Identity notes.
  for (const identity of identities) {
    const described = identity.candidates.map((thing) =>
      thing.embeddedIn
        ? `${thing.name} (${kindLabel(thing)}, described inside "${thing.embeddedIn.title}")`
        : `${thing.name} (${kindLabel(thing)})`,
    )
    const chosenIndex = identity.chosen ? identity.candidates.indexOf(identity.chosen) : -1
    notes.push(
      identity.chosen
        ? `identity: "${identity.name}" names ${identity.candidates.length} different things: ${described.join('; ')}. The question most likely means ${described[chosenIndex] ?? identity.chosen.name}; answer for it, keep the others' facts separate, and mention the other briefly only if the visitor could mean it.`
        : `identity: "${identity.name}" names ${identity.candidates.length} different things: ${described.join('; ')}. The question does not say which; answer for each briefly or ask which one.`,
    )
  }
  for (const note of excludedNotes) notes.push(`scope: ${note}`)
  for (const note of unknownScopes) notes.push(`unknown scope: ${note}`)
  for (const note of missingLinks) notes.push(`missing rule: ${note}`)
  // Only when nothing at all answers it: no subject, no carried context, no rule.
  if (input.shape.permission && !governing.length && !allSubjects.length && !carriedGoverning.length)
    notes.push(
      'permission: no current record states a rule that answers this question. Say that it is not known and who can confirm; never call it allowed or not allowed.',
    )

  // 5. Coverage for set questions.
  if (input.shape.shape === 'LIST') {
    const { coverage } = input
    notes.push(
      coverage.loadFailed || coverage.mode === 'NONE'
        ? 'coverage: the full venue guide is not loaded this turn. Present any set as examples ("including ..."), never as complete, and give no total count.'
        : coverage.incomplete || coverage.retrievalPartial
          ? 'coverage: only part of the venue\'s records is loaded. Present a set as examples ("including ..."), never as complete, and give no total count.'
          : coverage.mode === 'FULL'
            ? 'coverage: the complete venue guide is loaded. Check every record of the requested kind before answering; a full list or count is possible.'
            : 'coverage: the venue guide names every record, but shows full details only for some. Name every matching record; give details or eligibility only from records whose details are shown.',
    )
  }

  // 6. Choose records within the budget: current subjects, their rules, then carried context.
  const included: Included[] = []
  const add = (record: Indexed, origin: string, subject: Thing | null) => {
    const existing = included.find((item) => item.record === record)
    if (existing) {
      if (subject && !existing.subjectOf.includes(subject)) existing.subjectOf.push(subject)
      return
    }
    included.push({ record, label: '', origin, subjectOf: subject ? [subject] : [] })
  }
  const originFor = (thing: Thing) =>
    thing.origin === 'carried'
      ? 'subject of the earlier question, carried because this question refers back'
      : thing.origin === 'partial-name'
        ? 'probable subject (partial name match)'
        : thing.origin === 'identify-candidate'
          ? 'identification candidate'
          : 'named in this question'
  for (const thing of subjects) {
    for (const record of thing.records) add(record, originFor(thing), thing)
    if (thing.embeddedIn) add(thing.embeddedIn, `contains ${thing.name} (${kindLabel(thing)})`, null)
  }
  const ruleOrigin = (link: GoverningLink) => `rule for ${link.subject.name}: ${link.because}`
  for (const link of governing.filter((item) => subjects.includes(item.subject) || !allSubjects.includes(item.subject)))
    add(link.record, ruleOrigin(link), null)
  // A deep dive also gets records that talk about the subject (history, events, talks).
  if (input.shape.shape === 'DEEP_DIVE') {
    let related = 0
    for (const thing of subjects) {
      const keys = (thing.records.length ? thing.records.flatMap((record) => record.keys) : [guestPlaceIdentityKey(thing.name)]).filter(isSpecific)
      for (const record of indexed) {
        if (related >= 3) break
        if (thing.records.includes(record) || included.some((item) => item.record === record)) continue
        const text = guestPlaceIdentityKey(`${record.title} ${record.content}`)
        if (keys.some((key) => phraseIn(text, key))) {
          add(record, `mentions ${thing.name}`, null)
          related += 1
        }
      }
    }
  }
  for (const thing of carriedSubjects) for (const record of thing.records) add(record, originFor(thing), thing)
  for (const link of governing.filter((item) => carriedSubjects.includes(item.subject))) add(link.record, ruleOrigin(link), null)
  for (const record of carriedGoverning) add(record, 'rule used for the earlier question', null)

  const blocks: string[] = []
  let used = 0
  let truncated = false
  const rendered: Included[] = []
  for (const item of included) {
    if (rendered.length >= maxRecords) {
      truncated = true
      break
    }
    const label = `T${rendered.length + 1}`
    const subject = item.subjectOf.length > 0
    const kind = item.subjectOf[0] ? kindLabel(item.subjectOf[0]) : kindLabel(item.record.semantics)
    const lines = factLines(item.record, askedAttributes, subject, input.escape)
    const block = `<thing id="${label}" name="${input.escape(attr(item.record.title))}" kind="${input.escape(attr(kind))}" origin="${input.escape(attr(item.origin))}">\n${input.escape(item.record.content)}${lines.length ? `\n${lines.join('\n')}` : ''}\n</thing>`
    // Never cut a record: a dropped qualifier is worse than a missing record, which stays unknown.
    if (rendered.length && used + block.length > maxChars) {
      truncated = true
      continue
    }
    item.label = label
    rendered.push(item)
    blocks.push(block)
    used += block.length
  }
  if (truncated)
    notes.push('budget: more related records exist than fit here; the VENUE GUIDE still has them. Do not treat a thing missing from this block as nonexistent.')

  // 7. Visitor party.
  const party = buildGuestVisitorParty(input.visitorMessages)
  const partyLines = renderGuestVisitorParty(party)
  const useDecision = (shape: GuestAnswerShapeResult) =>
    shape.actionable || shape.permission || ['PLAN', 'COMPARE', 'DEEP_DIVE'].includes(shape.shape)
  // A short follow-up to an ongoing decision still needs its consequences. Only visitor
  // wording is consulted; no generated answer is carried as evidence or intent.
  // Only positively recognized narrow questions may suppress a use notice. An English
  // intent parser failing to recognize another language (or an unusual request) is not
  // evidence that the visitor is merely asking a fact.
  const descriptiveLookup = /\b(?:what (?:colou?r|name|year|height|length|width)|where (?:is|are)|who (?:built|designed)|when (?:was|were) .{1,80} (?:built|opened)|how many .{1,60} (?:are|does .{1,40} have)|(?:name|list|count) (?:all|every|the) physical places?|(?:when|what time) (?:is|does|are)|(?:is|are) .{1,60} scheduled open)\b/iu.test(input.question)
  const recognizedNarrowLookup = descriptiveLookup
    && !/\b(?:need|required|requirement|allowed|permit|rule|policy|refund|exchange|redeem|valid|access|participat|can|could|should|must|buy|buying|purchase|accept|accepting|book|booking|rent|renting|pay|paying|cost|price|deposit|token|ticket|pass|credit)\w*\b/iu.test(input.question)
  const requiresUseNotices = !recognizedNarrowLookup || useDecision(input.shape) ||
    (carry && input.visitorMessages.slice(-3, -1).some((message) => useDecision(guestAnswerShape(message)))) ||
    (party.persons.length > 0 && /\b(?:can|could|may|will)\b[\s\S]{0,80}\b(?:ride|join|participate|do|go)\b/iu.test(input.question))
  const unresolvedTogetherRoles = party.persons.length >= 2 &&
    /\b(?:together|with (?:him|her|them|me|each other))\b/iu.test(input.question) &&
    !party.roles.some((role) => role.role === 'companion' || role.role === 'rider')

  const weakSubject = (thing: Thing) => thing.origin === 'partial-name' || thing.origin === 'identify-candidate'
    || resolved.identities.some((identity) => identity.candidates.includes(thing) && identity.chosen !== thing)

  // 8. Required notices from rendered records only.
  const notices: GuestRequiredNotice[] = []
  for (const item of rendered) {
    if (!item.record.semantics.mustMention.length) continue
    // A rule can be present because the visitor names it while asking whether it
    // applies to an explicitly excluded subject. Naming the rule is not using its
    // offer. Require discussion of an included target rather than the policy name
    // or an actionable question alone. This also preserves notices for mixed-target
    // questions when the answer discusses the actual included product.
    // Match only the author's exclusion phrases, with ordinary number and
    // the optional trailing loan noun; never infer an exclusion from answer text.
    const questionScopeKey = guestPlaceIdentityKey(input.question).split(' ').map(singular).join(' ')
    const excludedQuestionTarget = item.record.semantics.kind === 'POLICY'
      && item.record.semantics.scope.doesNotApplyTo.some((target) => {
        const targetKey = guestPlaceIdentityKey(target).split(' ').map(singular).join(' ')
        const objectKey = targetKey.replace(/ loans?$/u, '')
        return phraseIn(questionScopeKey, targetKey)
          || (objectKey !== targetKey && objectKey.split(' ').length >= 2 && phraseIn(questionScopeKey, objectKey))
      })
    const governed = governing.filter((link) => link.record === item.record).map((link) => link.subject)
    const embeddedSubjects = allSubjects.filter((thing) => thing.embeddedIn === item.record)
    const owners = [...item.subjectOf, ...embeddedSubjects, ...governed]
    // Identity candidates remain in evidence to explain ambiguity. That does not make
    // every candidate the subject of use advice or make a shared alias identify it.
    const competing = resolved.identities.filter((identity) => identity.candidates.some((thing) => owners.includes(thing)))
    const identityUnselected = competing.length > 0 && !competing.some((identity) => identity.chosen && owners.includes(identity.chosen))
    const competingNames = identityUnselected ? competing.flatMap((identity) => identity.candidates
      .filter((thing) => !owners.includes(thing))
      .flatMap((thing) => [thing.name, ...thing.records.flatMap((record) => record.names)])) : []
    // An aliased titled offer can name its qualified product in prose without being
    // an embedded identity (e.g. alias Lantern Loft, prose Lantern Loft bundle).
    const qualifiedNames = identityUnselected ? item.record.names.flatMap((name) =>
      embeddedThings(guestPlaceIdentityKey(name), name, [{ ...item.record, keys: [] }])
        .filter((thing) => thing.derived === 'noun').map((thing) => thing.name)) : []
    const includedNames = [
      ...item.record.semantics.scope.appliesTo,
      ...governed.filter((thing) => !item.record.semantics.scope.doesNotApplyTo
        .some((target) => scopeTargetMatches(target, thing, namedTargets)))
        .flatMap((thing) => [thing.name, ...thing.records.flatMap((record) => record.names)]),
    ]
    const names = (excludedQuestionTarget ? includedNames : [
      ...item.record.names,
      ...qualifiedNames,
      ...embeddedSubjects.map((thing) => thing.name),
      ...item.subjectOf.flatMap((thing) => [thing.name, ...thing.records.flatMap((record) => record.names)]),
      ...governed.flatMap((thing) => (thing.records.length ? thing.records.flatMap((record) => record.names) : [thing.name])),
    ]).filter((name) => isSpecific(guestPlaceIdentityKey(name))
      && !competingNames.some((other) => guestPlaceIdentityKey(other) === guestPlaceIdentityKey(name)))
    // An action question makes a notice required only for this question's own subjects and their
    // rules; any other record's notice needs its name in the answer.
    const onAction = !excludedQuestionTarget && !identityUnselected && owners.some((thing) => !weakSubject(thing)) && (
      item.subjectOf.length > 0 || embeddedSubjects.length > 0 || governed.some((thing) => allSubjects.includes(thing)))
    for (const text of item.record.semantics.mustMention)
      notices.push({ text, names: [...new Set(names)], ref: item.record.ref, onAction,
        ...(excludedQuestionTarget ? { mentionExcludingNames: item.record.names } : {}),
        requiredForQuestion: requiresUseNotices })
  }

  // 9. Next-turn state: refs only; selected now at age 0, carried ones age.
  const nextRefs: GuestEvidenceStateRef[] = []
  const push = (record: Indexed, reason: GuestEvidenceStateRef['reason'], age: number) => {
    if (nextRefs.some((ref) => ref.ref === record.ref) || nextRefs.length >= 16) return
    nextRefs.push({ ref: record.ref, version: record.version, reason, age })
  }
  // Identification candidates are all carried; refineGuestEvidenceStateByAnswer keeps the ones the
  // reply named, which is what a follow-up "it" refers to.
  for (const thing of subjects) for (const record of thing.records) push(record, 'subject', 0)
  // Rules found for this question, including ones retrieved for a question with no named subject.
  for (const link of governing)
    if (subjects.includes(link.subject) || !allSubjects.includes(link.subject)) push(link.record, 'governing', 0)
  for (const thing of carriedSubjects) {
    const previousAge = previousRefs.find((ref) => ref.ref === thing.records[0]!.ref)?.age ?? 0
    // Still the topic when the question refers back; otherwise it fades within two turns.
    const age = referring && !subjects.length ? previousAge : previousAge + 1
    for (const record of thing.records) push(record, 'subject', age)
  }
  for (const link of governing)
    if (carriedSubjects.includes(link.subject)) {
      const previousAge = previousRefs.find((ref) => ref.ref === link.subject.records[0]?.ref)?.age ?? 0
      push(link.record, 'governing', referring && !subjects.length ? previousAge : previousAge + 1)
    }
  // A rule carried on its own (retrieved for an earlier question with no named subject).
  for (const record of carriedGoverning) {
    const previousAge = previousRefs.find((ref) => ref.ref === record.ref)?.age ?? 0
    push(record, 'governing', referring && !subjects.length ? previousAge : previousAge + 1)
  }
  // Exclusions and explicit unknown scopes are evidence too. Reload their IDs on the
  // next turn, but never carry their earlier applicability judgment as a governing rule.
  for (const [record, things] of scopeRecords) {
    const current = things.some((thing) => subjects.includes(thing))
    const previousAge = previousRefs.find((ref) => ref.ref === record.ref)?.age ?? 0
    push(record, 'scope', current ? 0 : referring && !subjects.length ? previousAge : previousAge + 1)
  }

  const dataParts = [
    ...blocks,
    ...(notes.length ? [`<evidence_notes>\n${input.escape(notes.join('\n'))}\n</evidence_notes>`] : []),
    ...(partyLines.length ? [`<visitor_party>\n${input.escape(partyLines.join('\n'))}\n</visitor_party>`] : []),
  ]
  const weakCandidateRefs: Record<string, string[]> = {}
  const weakNames: Record<string, string[]> = {}
  for (const thing of subjects.filter(weakSubject)) {
    const records = [...thing.records, ...(thing.embeddedIn ? [thing.embeddedIn] : [])]
    const rivals = resolved.identities.filter((identity) => identity.candidates.includes(thing))
      .flatMap((identity) => identity.candidates.filter((candidate) => candidate !== thing))
      .flatMap((candidate) => [candidate.name, ...candidate.records.flatMap((record) => record.names)])
      .map(guestPlaceIdentityKey)
    for (const record of records) {
      weakNames[record.ref] = [thing.name, ...record.names].filter((name) => !rivals.includes(guestPlaceIdentityKey(name)))
      weakCandidateRefs[record.ref] = [
        ...governing.filter((link) => link.subject === thing
          && !governing.some((other) => other.record === link.record && !weakSubject(other.subject)))
          .map((link) => link.record.ref),
        ...[...scopeRecords.entries()].filter(([, owners]) => owners.includes(thing) && owners.every(weakSubject))
          .map(([scopeRecord]) => scopeRecord.ref),
      ]
    }
  }
  const data = dataParts.length ? `<evidence_focus>\n${dataParts.join('\n')}\n</evidence_focus>` : ''
  return {
    rule: data ? `${RULE}${unresolvedTogetherRoles
      ? '\nROLE REVIEW: Going together does not specify whether both people participate or one accompanies the other. Briefly check both participating and any participant/companion option supported by the records, or ask which roles they mean. One person failing a participant minimum does not settle whether they can accompany someone. A stated unknown companion requirement remains unknown; do not grant or deny full eligibility from age alone.'
      : ''}\n${requiresUseNotices
      ? 'NOTICE RELEVANCE: This is a use or participation decision, or its follow-up. Keep the applicable authored notices and relevant unknowns.'
      : 'NOTICE RELEVANCE: This is a narrow fact lookup. Answer the asked fact without unrelated participation, refund or use notices merely because you name a thing. Include a notice if it answers the asked fact, or if you recommend or advise using its thing.'}` : '',
    data,
    state: { version: 'guest-evidence-state-v1', refs: nextRefs },
    refNames: Object.fromEntries(nextRefs.map((ref) => [ref.ref, weakNames[ref.ref] ?? byRef.get(ref.ref)?.names ?? []])),
    weakCandidateRefs,
    knownNames: [...new Set(indexed.flatMap((record) => record.names).filter((name) => isSpecific(guestPlaceIdentityKey(name))))],
    notices,
    rendered: rendered.map(({ record }) => ({
      ref: record.ref,
      title: record.title,
      content: record.content,
      ...(record.category !== undefined ? { category: record.category } : {}),
      ...(record.placeType !== undefined ? { placeType: record.placeType } : {}),
      ...(record.itemType !== undefined ? { itemType: record.itemType } : {}),
      version: record.version,
    })),
    supporting: [...scopeRecords.keys()]
      .filter((record) => !rendered.some((item) => item.record === record))
      .map(({ ref, title, content, category, placeType, itemType, version }) => ({
        ref, title, content, version,
        ...(category !== undefined ? { category } : {}),
        ...(placeType !== undefined ? { placeType } : {}),
        ...(itemType !== undefined ? { itemType } : {}),
      })),
    trace: {
      version: GUEST_EVIDENCE_ASSEMBLY_VERSION,
      shape: input.shape.shape,
      subjects: subjects.length,
      carriedSubjects: carriedSubjects.length,
      governing: governing.length,
      ambiguities: identities.filter((identity) => !identity.chosen).length,
      unknownScopes: unknownScopes.size,
      missingLinks: missingLinks.size,
      unavailable: unavailableCarried.length,
      changed: changed.length,
      persons: party.persons.length,
      topicChange,
      truncated,
      notices: notices.length,
    },
  }
}

/**
 * After the reply exists: when it names some of this turn's subjects, carry only those, so a
 * follow-up "can he ride it?" refers to the slide the reply identified, not every candidate. The
 * reply only selects among record refs already in the state; it never adds a ref or a fact, and
 * the next turn still reauthorizes and reloads every carried record. A reply that names no subject
 * preserves strong named continuity; unconfirmed weak candidates and their exclusive rules drop.
 */
export function refineGuestEvidenceStateByAnswer(
  assembly: Pick<GuestEvidenceAssembly, 'state' | 'refNames' | 'weakCandidateRefs'>,
  answer: string,
): GuestEvidenceState {
  const answerKey = guestPlaceIdentityKey(answer)
  const named = (ref: GuestEvidenceStateRef) =>
    (assembly.refNames[ref.ref] ?? []).some((name) => {
      const key = guestPlaceIdentityKey(name)
      return isSpecific(key) && phraseIn(answerKey, key)
    })
  const subjects = assembly.state.refs.filter((ref) => ref.reason === 'subject' && ref.age === 0)
  const kept = subjects.filter(named)
  const weak = assembly.weakCandidateRefs ?? {}
  const dropped = new Set(subjects.filter((ref) => !kept.includes(ref)
    && (kept.length > 0 || Object.hasOwn(weak, ref.ref))).map((ref) => ref.ref))
  // Do not leave an unconfirmed candidate's rules as freestanding continuity. A
  // shared rule stays if another retained weak candidate still owns it.
  for (const [subjectRef, related] of Object.entries(weak)) if (dropped.has(subjectRef))
    for (const ref of related) if (!Object.entries(weak).some(([owner, refs]) => !dropped.has(owner) && refs.includes(ref))) dropped.add(ref)
  if (!dropped.size) return assembly.state
  return { ...assembly.state, refs: assembly.state.refs.filter((ref) => !dropped.has(ref.ref)) }
}

/** Knowledge rows and places in the uniform record shape. */
export function guestEvidenceRecordFromKnowledge(entry: {
  id: string
  title: string
  category: string
  content: string
  updatedAt?: Date | string | null
}): GuestEvidenceRecord {
  const version =
    entry.updatedAt instanceof Date
      ? entry.updatedAt.toISOString()
      : typeof entry.updatedAt === 'string'
        ? entry.updatedAt
        : null
  return { ref: `knowledge:${entry.id}`, title: entry.title, content: entry.content, category: entry.category, version }
}

export function guestEvidenceRecordFromPlace(place: {
  id: string
  name: string
  type: string
  itemType?: string | null
  areaName?: string | null
  hours?: string | null
  shortDescription?: string | null
  longDescription?: string | null
}): GuestEvidenceRecord {
  const content = [
    place.shortDescription,
    place.longDescription,
    place.areaName ? `Location: ${place.areaName}` : null,
    place.hours ? `Hours: ${place.hours}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  // Places carry no row version in guest reads; the rendered fields are the comparable version.
  const version = [place.name, place.type, place.itemType, place.areaName, place.hours, place.shortDescription, place.longDescription]
    .map((value) => value ?? '')
    .join('\u0001')
  return {
    ref: `place:${place.id}`,
    title: place.name,
    content: content || place.name,
    placeType: place.type,
    itemType: place.itemType ?? null,
    version: `fields:${simpleHash(version)}`,
  }
}

function simpleHash(value: string): string {
  // FNV-1a 32-bit: a change detector for rendered fields, not a security hash.
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}
