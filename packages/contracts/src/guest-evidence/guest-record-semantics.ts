// Record semantics: the typed meaning of one venue record (a knowledge row or a place), read from
// the labeled lines that the authoring standard already uses ("Height:", "Price:", "Also called:")
// plus a small closed set of scope, link, notice and unknown labels.
//
// Why: the visitor-facing failures traced on 2026-11-01 were not missing text. A rider's height
// rule was applied to the companion, a rule listing four animal experiences was generalized to a
// fifth, and a pass's forfeiture consequence was dropped. The records said the right thing in
// prose; nothing in the runtime knew which clause was a role, a scope or a consequence.
//
// This parser never rewrites a record. Unrecognized lines stay prose. A record that uses none of
// the new labels still yields facts from its existing labeled lines, an inferred kind (marked
// inferred) and detected consequence sentences. Everything here is deterministic and pure.

import { guestPlaceIdentityKey } from './guest-place-identity'

export const GUEST_RECORD_SEMANTICS_VERSION = 'guest-record-semantics-v2'

/** The general "things" kinds from the content model; venue-specific detail stays in `type`. */
export type GuestThingKind = 'PLACE' | 'ITEM' | 'SERVICE' | 'POLICY' | 'EVENT' | 'KNOWLEDGE'

/** The visitor-party role a fact clause is about, when its wording says so. */
export type GuestFactRole =
  | 'accompanied'
  | 'alone'
  | 'companion'
  | 'adult'
  | 'child'
  | 'senior'
  | 'member'
  | 'group'

export type GuestFactQuantity = {
  value: number
  unit: 'in' | 'cm' | 'years' | 'usd' | 'minutes' | 'hours'
  /** Present for heights, so 122 cm and 48 in compare. */
  inches?: number
  /** "at least" / "minimum" vs "under" / "maximum"; null when the clause does not say. */
  bound: 'min' | 'max' | null
}

export type GuestFactClause = {
  text: string
  quantity: GuestFactQuantity | null
  role: GuestFactRole | null
  /** A clause that states something is not allowed, not offered or not required. */
  negative: boolean
  /** A clause that defers or says the value is not known ("ask staff", "not posted"). */
  unknown: boolean
}

export type GuestRecordFact = {
  /** The record's own label, as written ("Height", "Weekday price"). */
  label: string
  /** A normalized attribute key for matching ("height", "price", "age", "hours", ...). */
  attribute: string
  value: string
  clauses: GuestFactClause[]
}

export type GuestRecordScope = {
  /** Thing names, or a kind phrase such as "all coasters" (kept as written). */
  appliesTo: string[]
  doesNotApplyTo: string[]
}

export type GuestRecordSemantics = {
  version: typeof GUEST_RECORD_SEMANTICS_VERSION
  kind: GuestThingKind
  /** "stated" when a Kind: line or a place type set it; otherwise inferred from category/title. */
  kindSource: 'stated' | 'place' | 'inferred'
  /** Free-text type ("coaster", "admission offer", "animal experience"); may be null. */
  type: string | null
  aliases: string[]
  scope: GuestRecordScope
  /** Titles of other records this one is governed by or refers to; targets may be missing. */
  links: Array<{ relation: 'governed-by' | 'see-also'; target: string }>
  facts: GuestRecordFact[]
  conditions: string[]
  exceptions: string[]
  consequences: string[]
  /** Authored visitor-facing sentences that must accompany advice about this thing. */
  mustMention: string[]
  /** Explicit unknowns stated by the record ("Unknown: companion height"). */
  unknowns: string[]
  effective: string | null
  /** Prose sentences that state a consequence or forfeiture; model-visible, never enforced. */
  materialSentences: string[]
}

export type GuestSemanticsSource = {
  title: string
  content: string
  category?: string | null
  /** Places only. */
  placeType?: string | null
  itemType?: string | null
}

// Structural labels and their accepted spellings. Matching is case-insensitive on the whole label.
const STRUCTURAL: Record<string, readonly string[]> = {
  kind: ['kind', 'type of thing', 'what it is'],
  aliases: ['also called', 'also known as', 'aliases', 'alias', 'aka'],
  appliesTo: ['applies to'],
  doesNotApplyTo: ['does not apply to'],
  governedBy: ['governed by', 'see rules'],
  seeAlso: ['see also', 'related', 'see'],
  condition: ['condition', 'conditions', 'requires', 'requirement', 'requirements', 'eligibility'],
  exception: ['exception', 'exceptions', 'except'],
  consequence: ['consequence', 'consequences', 'if you accept', 'what happens'],
  mustMention: ['must mention', 'required notice', 'always mention', 'disclosure'],
  unknown: ['unknown', 'not known', 'not stated', 'not yet known', 'unconfirmed'],
  effective: ['effective', 'valid', 'valid dates', 'in effect', 'dates'],
}

const STRUCTURAL_BY_LABEL = new Map<string, string>(
  Object.entries(STRUCTURAL).flatMap(([field, labels]) => labels.map((label) => [label, field])),
)

// Labels whose value lists names. Generic words ("Rules:", "Covers:", "Not for:") stay fact lines:
// "Rules: no glass" or "Not for: under 3s" name conditions, not other records.
const LIST_FIELDS = new Set(['aliases', 'appliesTo', 'doesNotApplyTo', 'governedBy', 'seeAlso'])

// Fact attribute keys for the common labeled lines. Anything else keeps its own label as key.
const ATTRIBUTE_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ['height', /\b(?:height|tall|minimum height|rider height)\b/iu],
  ['age', /\b(?:age|ages|minimum age)\b/iu],
  ['price', /\b(?:price|prices|cost|fee|fees|admission|rate|rates)\b/iu],
  ['hours', /\b(?:hours|open|opening|schedule|times?|season)\b/iu],
  ['location', /\b(?:location|where|area|floor|gallery|zone|land)\b/iu],
  ['companion', /\b(?:companion|accompan\w*|supervision|chaperon\w*)\b/iu],
  ['accessibility', /\b(?:accessib\w*|wheelchair|transfer|ada)\b/iu],
  ['duration', /\b(?:duration|length|how long)\b/iu],
  ['booking', /\b(?:booking|reservation|reserve|book)\b/iu],
]

const KIND_WORDS: ReadonlyArray<[GuestThingKind, RegExp]> = [
  [
    'ITEM',
    /\b(?:offer|offers|ticket|tickets|pass|passes|admission|wristband|membership|package|discount|deal|voucher|coupon|combo|bundle|pricing|product|merchandise|animal|species|artwork|artifact|specimen)\b/iu,
  ],
  [
    'POLICY',
    /\b(?:policy|policies|rule|rules|regulations?|guidelines?|safety|code of conduct|prohibited|refunds?|weather)\b/iu,
  ],
  ['EVENT', /\b(?:event|events|show|shows|festival|performance|concert|parade|season calendar)\b/iu],
  ['SERVICE', /\b(?:service|services|rental|rentals|amenity|amenities|lockers?|first aid|tours?)\b/iu],
  [
    'PLACE',
    /\b(?:ride|rides|coaster|coasters|attraction|attractions|exhibit|exhibits|gallery|galleries|habitat|restaurant|restaurants|cafe|dining|shop|shops|area|building|room|theater|theatre|playground|pool|slide|slides)\b/iu,
  ],
]

// Consequence or forfeiture wording in prose. Deliberately narrow: a miss only means no highlight.
const MATERIAL_SENTENCE =
  /\b(?:gives? up|giving up|forfeit\w*|non[- ]?refundable|no refunds?|not refundable|cannot be (?:used|refunded|exchanged|combined|transferred)|can't be (?:used|refunded|exchanged)|void(?:s|ed)?\b|no re-?entry|will not be (?:re-?admitted|allowed|refunded)|loses?\b|lost\b|expires?\b|must be used|only valid|ends? (?:your|the|that) (?:visit|day))/iu

const NEGATIVE_CLAUSE =
  /\b(?:no|not|none|never|prohibited|forbidden|without|cannot)\b|n['’]t\b/iu

const UNKNOWN_CLAUSE =
  /\b(?:not (?:posted|published|stated|listed|announced|known)|unknown|varies|ask (?:staff|a team member|at)|check with|confirm (?:with|at)|to be announced|tba|tbd)\b/iu

function normalizeLabel(label: string): string {
  return label.trim().toLocaleLowerCase().replace(/\s+/gu, ' ')
}

/** A labeled line: a short label, a colon, a value. Times ("10:30 am") are not labels. */
const LABELED_LINE = /^\s*([A-Za-z][A-Za-z0-9 '’/&()-]{0,40}?)\s*:\s+(\S.*)$/u

function splitList(value: string): string[] {
  return value
    .split(/\s*[;|]\s*|\s*,\s*(?=[A-Z0-9])|\s+and\s+(?=[A-Z])/u)
    .map((item) => item.trim().replace(/\.$/u, ''))
    .filter((item) => item.length > 0 && item.length <= 120)
}

function attributeFor(label: string): string {
  for (const [attribute, pattern] of ATTRIBUTE_PATTERNS) if (pattern.test(label)) return attribute
  return guestPlaceIdentityKey(label) || 'detail'
}

function roleFor(text: string): GuestFactRole | null {
  const lower = text.toLocaleLowerCase()
  if (/\b(?:companion|chaperon\w*)\s+(?:must|needs?|has to|should)\b/u.test(lower)) return 'companion'
  if (/\b(?:qualifying |an? |the )?companion(?:s)?\b.*\b(?:at least|must be|minimum)\b/u.test(lower))
    return 'companion'
  if (
    /\b(?:with|alongside|accompanied by)\s+(?:a |an |the )?(?:qualifying |supervising |responsible )?(?:companion|adult|parent|guardian|chaperon\w*|rider)\b/u.test(
      lower,
    ) ||
    /\baccompanied\b/u.test(lower)
  )
    return 'accompanied'
  if (/\b(?:alone|solo|by (?:themselves|himself|herself)|unaccompanied|without (?:an? )?(?:adult|companion))\b/u.test(lower))
    return 'alone'
  if (/\b(?:companions?|chaperon\w*)\b/u.test(lower)) return 'companion'
  if (/\b(?:adults?|parents?|guardians?)\b/u.test(lower)) return 'adult'
  if (/\b(?:seniors?|ages? 6[05]\+?|65 and (?:older|over|up))\b/u.test(lower)) return 'senior'
  if (/\b(?:members?|membership)\b/u.test(lower)) return 'member'
  if (/\b(?:groups? of|group rate|groups?)\b/u.test(lower)) return 'group'
  if (/\b(?:child|children|kids?)\b/u.test(lower)) return 'child'
  return null
}

function quantityFor(text: string, attribute?: string): GuestFactQuantity | null {
  // Two numbers in one clause ("under 12 must stay with an adult 18 or older") cannot be bound to
  // one role and bound safely; the clause stays text. A wrong typed value is worse than none.
  if ((text.match(/\d+(?:\.\d+)?/gu) ?? []).length !== 1) return null
  const bound: GuestFactQuantity['bound'] =
    /\b(?:at least|minimum|min\b\.?|or (?:taller|older|more|over)|and (?:up|over|older))|\+/iu.test(text)
      ? 'min'
      : /\b(?:under|below|maximum|max\.?|no (?:taller|older|more) than|or (?:shorter|younger|less)|up to)\b/iu.test(
            text,
          )
        ? 'max'
        : null
  const height = text.match(/(\d{2,3}(?:\.\d+)?)\s*(?:in\b|inch(?:es)?\b|"|”)/iu)
  if (height) {
    const value = Number(height[1])
    return { value, unit: 'in', inches: value, bound }
  }
  const feet = text.match(/\b(\d)\s*(?:ft|feet|foot|')\s*(\d{1,2})?\s*(?:in\b|inch(?:es)?\b|"|”)?/iu)
  if (feet && /\b(?:tall|height|ft|feet|foot)\b|'/iu.test(text)) {
    const inches = Number(feet[1]) * 12 + Number(feet[2] ?? 0)
    return { value: inches, unit: 'in', inches, bound }
  }
  const cm = text.match(/(\d{2,3}(?:\.\d+)?)\s*cm\b/iu)
  if (cm) {
    const value = Number(cm[1])
    return { value, unit: 'cm', inches: Math.round((value / 2.54) * 10) / 10, bound }
  }
  const price = text.match(/\$\s?(\d+(?:\.\d{2})?)/u)
  if (price) return { value: Number(price[1]), unit: 'usd', bound }
  const age =
    text.match(/\b(?:age[sd]?\s*)(\d{1,2})\b/iu) ??
    text.match(/\b(\d{1,2})\s*(?:\+|years?(?:\s+old)?\b|yrs?\b|and (?:older|over|up)\b)/iu)
  if (age) return { value: Number(age[1]), unit: 'years', bound: bound ?? (/\+/u.test(text) ? 'min' : null) }
  // Under an "Age:" label a bare number is an age: "a companion must be at least 14".
  const bare = attribute === 'age' ? text.match(/\b(\d{1,2})\b/u) : null
  if (bare) return { value: Number(bare[1]), unit: 'years', bound }
  const minutes = text.match(/\b(\d{1,3})\s*(?:minutes?|mins?)\b/iu)
  if (minutes) return { value: Number(minutes[1]), unit: 'minutes', bound }
  return null
}

function clausesFor(value: string, attribute?: string): GuestFactClause[] {
  return value
    .split(/\s*;\s*/u)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      quantity: quantityFor(text, attribute),
      role: roleFor(text),
      negative: NEGATIVE_CLAUSE.test(text),
      unknown: UNKNOWN_CLAUSE.test(text),
    }))
}

function inferKind(source: GuestSemanticsSource): {
  kind: GuestThingKind
  kindSource: GuestRecordSemantics['kindSource']
  type: string | null
} {
  if (source.placeType !== undefined && source.placeType !== null) {
    const meaningfulItemType =
      source.itemType && !/^(?:physical_place|general_info|faq)$/u.test(source.itemType) ? source.itemType : null
    return {
      kind: 'PLACE',
      kindSource: 'place',
      type: guestThingPredicate(source.content) ?? meaningfulItemType ?? source.placeType,
    }
  }
  // Title first: "Group outings" in a "Tickets" category is still about offers, while a
  // "Ride rules" title in a "Rides" category is a policy.
  const predicate = guestThingPredicate(source.content)
  for (const text of [source.title, source.category ?? ''])
    for (const [kind, pattern] of KIND_WORDS)
      if (pattern.test(text))
        return {
          kind,
          kindSource: 'inferred',
          type: predicate ?? text.match(pattern)?.[0]?.toLocaleLowerCase() ?? null,
        }
  return { kind: 'KNOWLEDGE', kindSource: 'inferred', type: predicate }
}

function kindFromStatement(value: string): GuestThingKind {
  for (const [kind, pattern] of KIND_WORDS) if (pattern.test(value)) return kind
  return 'KNOWLEDGE'
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])|\n+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
}

export function parseGuestRecordSemantics(source: GuestSemanticsSource): GuestRecordSemantics {
  const inferred = inferKind(source)
  const semantics: GuestRecordSemantics = {
    version: GUEST_RECORD_SEMANTICS_VERSION,
    ...inferred,
    aliases: [],
    scope: { appliesTo: [], doesNotApplyTo: [] },
    links: [],
    facts: [],
    conditions: [],
    exceptions: [],
    consequences: [],
    mustMention: [],
    unknowns: [],
    effective: null,
    materialSentences: [],
  }
  const proseLines: string[] = []
  for (const rawLine of source.content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(LABELED_LINE)
    // A label never ends in a digit-only token: "Open 10" in "Open 10: 30" is not a label.
    // A label is a short noun phrase: "Open 10" (from "10:30") or "The coaster is fast" is prose.
    if (
      !match ||
      /\d$/u.test(match[1]!) ||
      match[1]!.trim().split(/\s+/u).length > 4 ||
      /\b(?:is|are|was|were|has|have|will|can)\b/iu.test(match[1]!)
    ) {
      proseLines.push(line)
      continue
    }
    const label = match[1]!.trim()
    const value = match[2]!.trim()
    const field = STRUCTURAL_BY_LABEL.get(normalizeLabel(label))
    if (!field) {
      const attribute = attributeFor(label)
      semantics.facts.push({ label, attribute, value, clauses: clausesFor(value, attribute) })
      continue
    }
    const items = LIST_FIELDS.has(field) ? splitList(value) : [value]
    switch (field) {
      case 'kind':
        semantics.kind = kindFromStatement(value)
        semantics.kindSource = 'stated'
        semantics.type = value.toLocaleLowerCase()
        break
      case 'aliases':
        semantics.aliases.push(...items)
        break
      case 'appliesTo':
        semantics.scope.appliesTo.push(...items)
        break
      case 'doesNotApplyTo':
        semantics.scope.doesNotApplyTo.push(...items)
        break
      case 'governedBy':
        semantics.links.push(...items.map((target) => ({ relation: 'governed-by' as const, target })))
        break
      case 'seeAlso':
        semantics.links.push(...items.map((target) => ({ relation: 'see-also' as const, target })))
        break
      case 'condition':
        semantics.conditions.push(value)
        break
      case 'exception':
        semantics.exceptions.push(value)
        break
      case 'consequence':
        semantics.consequences.push(value)
        break
      case 'mustMention':
        semantics.mustMention.push(value)
        break
      case 'unknown':
        semantics.unknowns.push(value)
        break
      case 'effective':
        semantics.effective = value
        break
    }
  }
  for (const fact of semantics.facts)
    if (MATERIAL_SENTENCE.test(fact.value)) semantics.materialSentences.push(`${fact.label}: ${fact.value}`)
  for (const sentence of sentences(proseLines.join('\n')))
    if (MATERIAL_SENTENCE.test(sentence) && sentence.length <= 400)
      semantics.materialSentences.push(sentence)
  semantics.materialSentences = [...new Set(semantics.materialSentences)].slice(0, 6)
  semantics.aliases = [...new Set(semantics.aliases)]
  return semantics
}

/**
 * What a record says the thing is, from its first sentence: "Thunder Run is a wooden roller
 * coaster with ..." gives "wooden roller coaster". Bounded so a later clause ("offered when
 * lightning closes most rides") never becomes the thing's kind.
 */
export function guestThingPredicate(content: string): string | null {
  const first = content.split(/(?<=[.!?])\s|\n/u)[0] ?? ''
  const match = first.match(/\b(?:is|are)\s+(?:a|an|the|one of the|our)\s+(.+)$/iu)
  if (!match) return null
  // Commas between adjectives ("a shaded, tree-filled exhibit") are part of the noun phrase.
  const words = match[1]!.replace(/[.;:!?].*$/u, '').replace(/,/gu, '').split(/\s+/u)
  const stop = /^(?:with|that|which|who|where|when|for|in|at|near|on|from|by|and|offered|located|featuring|including|while|to|beside|behind|inside|next|across|serving|selling|open|opens)$/iu
  const kept: string[] = []
  for (const word of words) {
    if (stop.test(word) || kept.length >= 6) break
    kept.push(word)
  }
  return kept.length ? kept.join(' ').toLocaleLowerCase() : null
}

/** Names a thing can be called by: its title, a title's short form before ":" or "(", aliases. */
export function guestThingNames(title: string, semantics: GuestRecordSemantics): string[] {
  const short = title.split(/\s*(?:[:(–—]| - )\s*/u)[0]?.trim()
  return [...new Set([title, ...(short && short !== title ? [short] : []), ...semantics.aliases])]
    .map((name) => name.trim())
    .filter((name) => guestPlaceIdentityKey(name).length >= 3)
}

/** Author-facing checks for the new labels; does not judge facts. Targets resolve by name. */
export type GuestRecordSemanticsFinding = {
  code:
    | 'LINK_TARGET_MISSING'
    | 'SCOPE_TARGET_MISSING'
    | 'MUST_MENTION_TOO_LONG'
    | 'MUST_MENTION_NOT_SENTENCE'
    | 'CONSEQUENCE_WITHOUT_NOTICE'
    | 'SCOPE_CONFLICT'
    | 'GOVERNING_SCOPE_CONFLICT'
  record: string
  detail: string
}

export function lintGuestRecordSemantics(
  records: ReadonlyArray<{ title: string; semantics: GuestRecordSemantics }>,
): GuestRecordSemanticsFinding[] {
  const names = new Set(
    records.flatMap((record) => guestThingNames(record.title, record.semantics).map(guestPlaceIdentityKey)),
  )
  const findings: GuestRecordSemanticsFinding[] = []
  for (const record of records) {
    const ownNames = new Set(guestThingNames(record.title, record.semantics).map(guestPlaceIdentityKey))
    const excluded = new Set(record.semantics.scope.doesNotApplyTo.map(guestPlaceIdentityKey))
    for (const target of record.semantics.scope.appliesTo) {
      if (excluded.has(guestPlaceIdentityKey(target)))
        findings.push({ code: 'SCOPE_CONFLICT', record: record.title, detail: `Both Applies to and Does not apply to name ${target}.` })
    }
    for (const link of record.semantics.links.filter((link) => link.relation === 'governed-by')) {
      const policies = records.filter((candidate) => guestThingNames(candidate.title, candidate.semantics)
        .map(guestPlaceIdentityKey).includes(guestPlaceIdentityKey(link.target)))
      if (policies.length === 1 && policies[0]!.semantics.scope.doesNotApplyTo.some((target) => ownNames.has(guestPlaceIdentityKey(target))))
        findings.push({ code: 'GOVERNING_SCOPE_CONFLICT', record: record.title, detail: `${link.target} is named as governing this record but explicitly excludes it.` })
    }
    for (const link of record.semantics.links)
      if (!names.has(guestPlaceIdentityKey(link.target)))
        findings.push({ code: 'LINK_TARGET_MISSING', record: record.title, detail: link.target })
    for (const target of [...record.semantics.scope.appliesTo, ...record.semantics.scope.doesNotApplyTo])
      if (!/^(?:all|every|any)\b/iu.test(target) && !names.has(guestPlaceIdentityKey(target)))
        findings.push({ code: 'SCOPE_TARGET_MISSING', record: record.title, detail: target })
    for (const notice of record.semantics.mustMention) {
      if (notice.length > 240)
        findings.push({ code: 'MUST_MENTION_TOO_LONG', record: record.title, detail: notice })
      if (!/[.!?]$/u.test(notice))
        findings.push({ code: 'MUST_MENTION_NOT_SENTENCE', record: record.title, detail: notice })
    }
    if (record.semantics.consequences.length && !record.semantics.mustMention.length)
      findings.push({
        code: 'CONSEQUENCE_WITHOUT_NOTICE',
        record: record.title,
        detail: record.semantics.consequences[0]!,
      })
  }
  return findings
}
