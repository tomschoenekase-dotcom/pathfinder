/** Optional computation over ONE admitted source snapshot. No fetching or publication authority.
 * Deliberately narrow English grammar: unsupported clauses abstain on the entire subject.
 * Calendar dates are ISO YYYY-MM-DD; the existing schedule evaluator uses Monday=0 internally.
 */
import { dayStatus, parseVenueSchedule, venueLocalNow } from './guest-today-status'
import { createHash } from 'node:crypto'

export type ComputedFactsMode = 'off' | 'schedule' | 'height' | 'all'
export type ComputedSubject = { id: string; name: string; kind: 'venue' | 'place' | 'knowledge' }
export type ComputedRecord = {
  key: string
  subjectId: string
  kind: 'schedule' | 'height'
  content: string
  version: string
}
type Provenance = {
  subjectId: string
  subjectKind: ComputedSubject['kind']
  subjectName: string
  sourceKeys: string[]
  sourceVersion: string
  recordVersions: string[]
  asOf: string
}
type ScheduleFact = {
  kind: 'schedule'
  date: string
  status: string
  open?: number
  close?: number
  nextOpening?: { date: string; minute: number }
  searchHorizonDays: number
}
type HeightFact = {
  kind: 'height'
  status: HeightStatus
  riderHeight: string
  raw: string
  condition?: string
}
export type ComputedPacket = {
  state: 'known' | 'partial' | 'unknown'
  facts: Array<(ScheduleFact | HeightFact) & Provenance>
  abstentions: string[]
  omittedDays: number
}

export function guestComputedFactsMode(
  env: Record<string, string | undefined> = process.env,
): ComputedFactsMode {
  const mode = env.GUEST_CHAT_COMPUTED_FACTS?.trim().toLowerCase()
  return mode === 'schedule' || mode === 'height' || mode === 'all' ? mode : 'off'
}

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const months = [
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
const iso = (date: { y: number; m: number; d: number }) =>
  `${date.y}-${String(date.m).padStart(2, '0')}-${String(date.d).padStart(2, '0')}`
function fromIso(value: string): { y: number; m: number; d: number } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null
  const [y, m, d] = value.split('-').map(Number) as [number, number, number]
  const date = new Date(Date.UTC(y, m - 1, d))
  return iso({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }) ===
    value
    ? { y, m, d }
    : null
}
function offsetDay(value: string, offset: number): string {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offset)
  return date.toISOString().slice(0, 10)
}

/** Complete calendar question grammar; no supported token is extracted from unclassified prose.
 * Accept a day list alone or a neutral hours/status prefix plus that list. A day is today,
 * tomorrow, now/currently, a full weekday, or a fully qualified date (optional matching weekday).
 * Lists join complete atoms with comma/and. Any unconsumed modifier, clause or alternative abstains.
 */
export function resolveRequestedDays(input: { question: string; now: Date; timeZone: string }): {
  dates: string[]
  omittedDays: number
  reason?: string
} {
  const unknown = (reason: string) => ({ dates: [], omittedDays: 0, reason })
  const local = venueLocalNow(input.now, input.timeZone)
  if (!local) return unknown('invalid-clock-or-zone')
  const q = input.question
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[?!.]$/u, '')
    .trim()
  if (!q || q.length > 500) return unknown('unsupported-calendar-question')
  const today = iso(local.date)
  if (/^(?:open|closed|hours|opening hours)$/u.test(q)) return { dates: [today], omittedDays: 0 }
  // These prefixes have no free-text slots. In particular arbitrary subjects cannot hide a
  // modifier/negation. Questions about named subjects outside this grammar simply abstain.
  const prefix =
    /^(?:(?:hours|opening hours|open|closed)|(?:are you|is it) (?:open|closed)|what are your (?:hours|opening hours))(?: on)?\s+/u
  let remainder = q.replace(prefix, '')
  const namedDate = `(?:${months.join('|')})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}`
  const atom = new RegExp(
    `^(?:(?:(?<weekday>${weekdays.join('|')})(?:\\s*,\\s*|\\s+))?(?<date>\\d{4}-\\d{2}-\\d{2}|${namedDate})|(?<relative>today|tomorrow|now|currently|${weekdays.join('|')}))(?=$|\\s|,)`,
    'u',
  )
  const dates: string[] = []
  const todayWeekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7
  while (remainder) {
    const token = atom.exec(remainder)
    if (!token) return unknown('unsupported-calendar-question')
    if (token.groups!.date) {
      const raw = token.groups!.date
      const named = new RegExp(
        `^(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})$`,
        'u',
      ).exec(raw)
      const value = named
        ? iso({ y: Number(named[3]), m: months.indexOf(named[1]!) + 1, d: Number(named[2]) })
        : raw
      const date = fromIso(value)
      if (!date) return unknown('invalid-date')
      const weekday = (new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() + 6) % 7
      if (token.groups!.weekday && weekdays[weekday] !== token.groups!.weekday)
        return unknown('contradictory-weekday-date')
      dates.push(value)
    } else {
      const relative = token.groups!.relative!
      dates.push(
        relative === 'tomorrow'
          ? offsetDay(today, 1)
          : weekdays.includes(relative)
            ? offsetDay(today, (weekdays.indexOf(relative) - todayWeekday + 7) % 7)
            : today,
      )
    }
    remainder = remainder.slice(token[0].length)
    if (!remainder) break
    const separator = /^(?:\s*,\s*(?:and\s+)?|\s+and\s+)/u.exec(remainder)
    if (!separator) return unknown('unsupported-calendar-question')
    remainder = remainder.slice(separator[0].length)
    if (!remainder) return unknown('unsupported-calendar-question')
  }
  const unique = [...new Set(dates)]
  return { dates: unique.slice(0, 8), omittedDays: Math.max(0, unique.length - 8) }
}

function scheduleContent(content: string): string {
  // A completely anchored dated-hours clause has no implied year or subject.
  const dated = new RegExp(
    `^(?:Hours:\\s*)?(${months.join('|')}) (\\d{1,2}),? (\\d{4}):?[, ]+(.+?)[.]?$`,
    'iu',
  ).exec(content.trim())
  if (dated) {
    const date = `${dated[1]} ${dated[2]} ${dated[3]}`
    return `Hours: daily ${dated[4]} during ${date} to ${date}`
  }
  return content.replace(new RegExp(`^(${weekdays.join('|')}):?\\s+`, 'iu'), 'Hours: $1 ')
}

/** No split/overnight guess; the existing whole-topic parser owns admission of schedule prose. */
export function evaluateSubjectSchedule(input: {
  content: string
  subjectName: string
  date: string
  now: Date
  timeZone: string
  venueScope?: boolean
}): ScheduleFact | { status: 'unknown'; reason: string } {
  if (input.content.length > 5_000) return { status: 'unknown', reason: 'schedule-budget' }
  const schedule = parseVenueSchedule(scheduleContent(input.content), input.subjectName, {
    allowGenericSubjects: input.venueScope === true,
  })
  const local = venueLocalNow(input.now, input.timeZone)
  const date = fromIso(input.date)
  if (!schedule || !local || !date)
    return { status: 'unknown', reason: 'unparsed-schedule-or-clock' }
  const status = dayStatus(schedule, date)
  if (status.kind === 'unknown' || (status.kind === 'open' && !status.times))
    return { status: 'unknown', reason: 'unknown-day-or-close' }
  const fact: ScheduleFact = {
    kind: 'schedule',
    date: input.date,
    status: status.kind,
    searchHorizonDays: 370,
  }
  if (status.kind === 'open' && status.times) {
    fact.open = status.times.open
    fact.close = status.times.close
    fact.status =
      input.date !== iso(local.date)
        ? 'posted_hours'
        : local.minute < status.times.open
          ? 'before_opening'
          : local.minute >= status.times.close
            ? 'after_closing'
            : 'open_by_schedule'
  }
  // Future dates get posted hours/closures only, never an open-now claim.
  if (fact.status === 'before_opening' && fact.open !== undefined)
    fact.nextOpening = { date: input.date, minute: fact.open }
  else if (fact.status !== 'open_by_schedule' && fact.status !== 'posted_hours') {
    for (let offset = 1; offset <= 370; offset++) {
      const nextDate = offsetDay(input.date, offset)
      const next = dayStatus(schedule, fromIso(nextDate)!)
      // Unknown intervening days cannot prove the next opening. No result is never "permanently closed".
      if (next.kind === 'unknown') break
      if (next.kind === 'open') {
        if (next.times) fact.nextOpening = { date: nextDate, minute: next.times.open }
        break
      }
    }
  }
  return fact
}

// Exact rational centi-millimetres. No rounding at a safety threshold, including decimals.
type Length = { numerator: bigint; denominator: bigint }
function length(value: string, unit: string): Length | null {
  if (!/^\d{1,3}(?:\.\d{1,6})?$/u.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const denominator = 10n ** BigInt(fraction.length)
  const factor = unit === 'cm' ? 1000n : 2540n
  return { numerator: BigInt(`${whole}${fraction}`) * factor, denominator }
}
function measurement(value: string): Length | null {
  const feet =
    /^(\d)\s*(?:ft|feet|foot|')\s*(\d{1,2}(?:\.\d{1,6})?)\s*(?:in|inches|inch|")$/iu.exec(
      value.trim(),
    )
  if (feet) {
    const inches = length(feet[2]!, 'in')
    if (!inches || Number(feet[2]) >= 12) return null
    return {
      ...inches,
      numerator: inches.numerator + BigInt(feet[1]!) * 12n * 2540n * inches.denominator,
    }
  }
  const match = /^(\d{1,3}(?:\.\d{1,6})?)\s*(cm|in|inch|inches|")$/iu.exec(value.trim())
  return match ? length(match[1]!, match[2]!.toLowerCase()) : null
}
const compare = (a: Length, b: Length) => {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator
  return difference < 0n ? -1 : difference > 0n ? 1 : 0
}
type HeightRule = {
  raw: string
  state: 'known' | 'unknown'
  minimum?: Length
  maximum?: Length
  condition?: string
}
type HeightStatus = 'below_minimum' | 'height_condition_met' | 'above_maximum' | 'unknown'

/** Only a complete plain height condition. Companion, age, health, uncertain clauses stay unresolved. */
export function parseHeightRule(raw: string): HeightRule {
  if (raw.length > 5_000) return { raw, state: 'unknown' }
  const clauses = raw
    .trim()
    .split(/\r?\n|(?<=[.!?])\s+(?=[A-Z])/u)
    .filter(Boolean)
  const plain =
    /^(?:height:\s*)?\d{1,3}(?:\.\d{1,6})?\s*(?:in|inches|inch|cm)\s*(?:minimum|to ride)[.]?$|^(?:height:\s*)?(?:minimum|min)\s*\d|^(?:height:\s*)?\d+(?:\.\d+)?\s*(?:to|-)\s*\d+(?:\.\d+)?\s*(?:in|inches|inch|cm)[.]?$/iu
  const prose =
    /^(?:riders?|guests?|children) must be at least (\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm) tall(?: and ride alone)?[.]?$/iu
  const candidates = clauses.filter(
    (clause) => plain.test(clause.trim()) || prose.test(clause.trim()),
  )
  if (candidates.length !== 1) return { raw, state: 'unknown' }
  const remainingClauses = clauses.filter((clause) => clause !== candidates[0])
  // Labels and descriptive-looking prefixes do not establish that a clause is irrelevant to
  // eligibility. Apart from this fully recognised one-at-a-time clause, additional prose abstains.
  if (remainingClauses.some((clause) => !/^riders go one at a time[.]?$/iu.test(clause.trim())))
    return { raw, state: 'unknown' }
  let value = candidates[0]!
    .trim()
    .replace(/^height:\s*/iu, '')
    .replace(/[.]$/u, '')
    .trim()
  const described = prose.exec(value)
  if (described) value = `${described[1]} ${described[2]} minimum`
  const unknown: HeightRule = { raw, state: 'unknown' }
  const min =
    /^(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)\s*(?:minimum|to ride)$/iu.exec(value) ??
    /^(?:minimum|min)\s*(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)$/iu.exec(value)
  if (min) {
    const minimum = length(min[1]!, min[2]!.toLowerCase())
    return minimum ? { raw, state: 'known', minimum, condition: candidates[0]!.trim() } : unknown
  }
  const range =
    /^(\d{1,3}(?:\.\d{1,6})?)\s*(?:to|-)\s*(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)$/iu.exec(
      value,
    )
  if (!range) return unknown
  const minimum = length(range[1]!, range[3]!.toLowerCase())
  const maximum = length(range[2]!, range[3]!.toLowerCase())
  return minimum && maximum && compare(minimum, maximum) <= 0
    ? { raw, state: 'known', minimum, maximum, condition: candidates[0]!.trim() }
    : unknown
}

export function compareRiderHeight(rule: HeightRule, height: string): { status: HeightStatus } {
  const rider = measurement(height)
  if (!rider || rule.state !== 'known' || !rule.minimum) return { status: 'unknown' }
  if (compare(rider, rule.minimum) < 0) return { status: 'below_minimum' }
  if (rule.maximum && compare(rider, rule.maximum) > 0) return { status: 'above_maximum' }
  return { status: 'height_condition_met' }
}

/** Complete assertion grammar, never token extraction. No free-text slots or discarded clauses.
 * A scalar alone / Height: scalar; My child is scalar [tall] [. Can they ride?];
 * I am scalar [tall] [. Can I ride?]; or Our children are scalar and scalar ...
 * [. Which slides meet each height condition?]. Each list member repeats its unit.
 * Exact conversion/feet validation remains owned by measurement(). All other text abstains.
 */
function riderMeasurements(question: string): string[] {
  const q = question.normalize('NFKC').toLowerCase().trim()
  if (!q || q.length > 500) return []
  const number = String.raw`\d{1,3}(?:\.\d{1,6})?`
  const scalar = `${number}\\s*(?:cm|in|inch|inches)`
  const feet = String.raw`\d\s*(?:ft|feet|foot)\s*\d{1,2}(?:\.\d{1,6})?\s*(?:in|inch|inches)`
  const value = `(?:${feet}|${scalar})`
  const single = new RegExp(`^(?:height:\\s*)?(${value})[.]?$`, 'u').exec(q)
  // Every wrapper is anchored, including the optional complete follow-up question.
  const assertion = new RegExp(
    `^(?:my child is (${value})(?: tall)?(?:[.]|[.] can they ride[?])?|i am (${value})(?: tall)?(?:[.]|[.] can i ride[?])?)$`,
    'u',
  ).exec(q)
  const list = new RegExp(
    `^our children are (${value}(?: and ${value}){1,7})(?:[.]|[.] which slides meet each height condition[?])?$`,
    'u',
  ).exec(q)
  const heights = single
    ? [single[1]!]
    : assertion
      ? [assertion[1] ?? assertion[2]!]
      : list
        ? list[1]!.split(' and ')
        : []
  return heights.length && heights.every((height) => measurement(height))
    ? [...new Set(heights)]
    : []
}

export function buildGuestComputedFacts(input: {
  mode: ComputedFactsMode
  question: string
  resolvedSubject: ComputedSubject | null
  authorizedRecords: ReadonlyArray<ComputedRecord>
  sourceVersion: string
  asOf: Date
  now: Date
  timeZone: string
  activeUpdates?: ReadonlyArray<unknown>
  coverage: { fresh: boolean; complete: boolean }
}): ComputedPacket {
  const packet: ComputedPacket = { state: 'unknown', facts: [], abstentions: [], omittedDays: 0 }
  const abstain = (reason: string) => {
    packet.abstentions.push(reason)
    return packet
  }
  if (input.mode === 'off') return packet
  if (
    !input.resolvedSubject ||
    !input.sourceVersion ||
    !input.coverage.fresh ||
    !input.coverage.complete ||
    input.activeUpdates?.length ||
    !Number.isFinite(input.asOf.getTime()) ||
    !Number.isFinite(input.now.getTime())
  )
    return abstain('untrusted-or-ambiguous-snapshot')
  const subject = input.resolvedSubject
  const records = input.authorizedRecords.filter((row) => row.subjectId === subject.id)
  if (records.some((row) => !row.key || !row.version)) return abstain('missing-record-provenance')
  const provenance = (sources: ComputedRecord[]): Provenance => ({
    subjectId: subject.id,
    subjectKind: subject.kind,
    subjectName: subject.name,
    sourceKeys: sources.map((row) => row.key),
    sourceVersion: input.sourceVersion,
    recordVersions: sources.map((row) => row.version),
    asOf: input.asOf.toISOString(),
  })
  if (input.mode === 'schedule' || input.mode === 'all') {
    const schedules = records.filter((row) => row.kind === 'schedule')
    const bodies = [...new Set(schedules.map((row) => row.content.trim()))]
    if (bodies.length !== 1) packet.abstentions.push('missing-or-conflicting-schedules')
    else {
      const requested = resolveRequestedDays(input)
      packet.omittedDays = requested.omittedDays
      if (!requested.dates.length) packet.abstentions.push(requested.reason ?? 'no-requested-day')
      for (const date of requested.dates) {
        const result = evaluateSubjectSchedule({
          content: bodies[0]!,
          subjectName: subject.name,
          date,
          now: input.now,
          timeZone: input.timeZone,
          venueScope: subject.kind === 'venue',
        })
        if ('reason' in result) packet.abstentions.push(result.reason)
        else packet.facts.push({ ...result, ...provenance(schedules) })
      }
    }
  }
  if (input.mode === 'height' || input.mode === 'all') {
    const heights = riderMeasurements(input.question)
    const sources = records.filter((row) => row.kind === 'height')
    // Whole eligibility body is parsed, never extract a settled line and discard other conditions.
    const bodies = [...new Set(sources.map((row) => row.content.trim()))]
    if (!heights.length || bodies.length !== 1) packet.abstentions.push('ambiguous-rider-or-rule')
    else {
      const raw = bodies[0]!
      const rule = parseHeightRule(raw)
      for (const height of heights) {
        const result = compareRiderHeight(rule, height)
        if (result.status === 'unknown') packet.abstentions.push('unresolved-height-conditions')
        else
          packet.facts.push({
            kind: 'height',
            ...result,
            riderHeight: height,
            raw,
            ...(rule.condition ? { condition: rule.condition } : {}),
            ...provenance(sources),
          })
      }
    }
  }
  packet.state = packet.facts.length
    ? packet.abstentions.length || packet.omittedDays
      ? 'partial'
      : 'known'
    : 'unknown'
  return packet
}

/** Rendering contains no internal IDs. The caller MUST escape and wrap this as untrusted data. */
export function renderGuestComputedFacts(packet: ComputedPacket): string {
  if (!packet.facts.length) return ''
  const facts = packet.facts.map((fact) =>
    fact.kind === 'height'
      ? {
          subject: fact.subjectName,
          scope: fact.subjectKind === 'venue' ? 'venue' : 'named_subject',
          kind: fact.kind,
          heightValue: fact.riderHeight,
          status: fact.status,
          rule: fact.condition ?? fact.raw,
        }
      : {
          subject: fact.subjectName,
          scope: fact.subjectKind === 'venue' ? 'venue' : 'named_subject',
          kind: fact.kind,
          date: fact.date,
          status: fact.status,
          openMinute: fact.open,
          closeMinute: fact.close,
          nextOpening: fact.nextOpening,
          searchHorizonDays: fact.searchHorizonDays,
        },
  )
  return `COMPUTED POSTED FACTS: ${JSON.stringify(facts)}\nThese are conditions from admitted posted records, not live verification. Each measured value is compared separately without binding it to an age or person. Height condition met is not unconditional ride permission. Venue facts do not establish an outlet's status. Missing facts and missing next openings remain unknown; this is only the admitted subset, never a complete real-world inventory. Minutes are local minutes after midnight. Use only the named subject and date; retain all ordinary source limitations.`
}

type PromptPlace = {
  id?: string
  name: string
  hours: string | null
  shortDescription: string | null
  longDescription: string | null
}
type PromptKnowledge = { id?: string; title: string; category: string; content: string }

/** The FULL renderer's recordIds are full-body admission, not directory/name-only membership.
 * Use that exact ledger only while the same snapshot is fresh. Its bodies win over an unchanged
 * retrieved excerpt because these are the actual whole bodies already sent in the cached guide.
 */
export function admitGuestComputedSources(input: {
  guideMode: 'FULL' | 'DIRECTORY' | 'NONE'
  guideRecordIds: ReadonlySet<string>
  rendererTruncated: boolean
  freshComplete: boolean
  dynamicPlaces: ReadonlyArray<PromptPlace>
  dynamicKnowledge: ReadonlyArray<PromptKnowledge>
  guidePlaces: ReadonlyArray<PromptPlace>
  guideKnowledge: ReadonlyArray<PromptKnowledge>
}): { places: PromptPlace[]; knowledge: PromptKnowledge[] } {
  const places = new Map(
    input.dynamicPlaces.map((row, index) => [row.id ?? `dynamic:${index}`, row]),
  )
  const knowledge = new Map(
    input.dynamicKnowledge.map((row, index) => [row.id ?? `dynamic:${index}`, row]),
  )
  if (input.guideMode === 'FULL' && input.freshComplete && !input.rendererTruncated) {
    for (const row of input.guidePlaces)
      if (row.id && input.guideRecordIds.has(`place:${row.id}`)) places.set(row.id, row)
    for (const row of input.guideKnowledge)
      if (row.id && input.guideRecordIds.has(`knowledge:${row.id}`)) knowledge.set(row.id, row)
  }
  return { places: [...places.values()], knowledge: [...knowledge.values()] }
}
const identity = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Source-driven router adapter over finally admitted whole bodies. Each fact keeps its own
 * subject and date; the model selects applicable facts without inheriting venue hours for outlets.
 * Authorized metadata can veto an omitted/ambiguous subject, never supply source facts.
 */
export function buildGuestComputedFactsForPrompt(input: {
  mode: ComputedFactsMode
  question: string
  venue: { id: string; name: string }
  places: ReadonlyArray<PromptPlace>
  knowledge: ReadonlyArray<PromptKnowledge>
  identityPlaces: ReadonlyArray<{ id?: string; name: string }>
  /** Complete authorized metadata for conflict/omission veto only, never source evidence. */
  identityKnowledge?: ReadonlyArray<{ id?: string; title: string; category: string }>
  now: Date
  timeZone: string | undefined
  freshComplete: boolean
  identityAmbiguous: boolean
  activeUpdates: ReadonlyArray<unknown>
}): ComputedPacket {
  const packet: ComputedPacket = { state: 'unknown', facts: [], abstentions: [], omittedDays: 0 }
  const stop = (reason: string) => {
    packet.abstentions.push(reason)
    return packet
  }
  if (input.mode === 'off') return packet
  if (
    !input.timeZone ||
    !input.freshComplete ||
    input.identityAmbiguous ||
    input.activeUpdates.length
  )
    return stop('untrusted-or-ambiguous-snapshot')
  const groups = new Map<string, { subject: ComputedSubject; records: ComputedRecord[] }>()
  const add = (
    subject: ComputedSubject,
    key: string,
    kind: ComputedRecord['kind'],
    content: string,
  ) => {
    const subjectKey = `${subject.kind}:${subject.id}`
    const group = groups.get(subjectKey) ?? { subject, records: [] }
    group.records.push({ key, kind, content, subjectId: subject.id, version: digest(content) })
    groups.set(subjectKey, group)
  }
  const isHours = (topic: { title: string; category: string }) =>
    /^hours$/iu.test(topic.category) || /\b(?:hours|opening times?)\b/iu.test(topic.title)
  const hours = (input.identityKnowledge ?? input.knowledge).filter(isHours)
  if (hours.some((topic) => !input.knowledge.some((body) => body.id === topic.id)))
    packet.abstentions.push('hours-body-not-admitted')
  else
    for (const topic of input.knowledge.filter(isHours))
      if (topic.id)
        add(
          { id: input.venue.id, name: input.venue.name, kind: 'venue' },
          `knowledge:${topic.id}`,
          'schedule',
          topic.content,
        )
  const heightCue = /\bheight\s*:|\b(?:riders?|guests?|children) must be at least \d/iu
  const uniquePlace = (name: string) =>
    input.identityPlaces.filter((place) => identity(place.name) === identity(name)).length === 1
  for (const place of input.places) {
    if (!place.id || !uniquePlace(place.name)) {
      packet.abstentions.push('ambiguous-place-label')
      continue
    }
    const subject: ComputedSubject = { id: place.id, name: place.name, kind: 'place' }
    const matchingTopics = (input.identityKnowledge ?? input.knowledge).filter(
      (topic) => identity(topic.title) === identity(place.name),
    )
    if (matchingTopics.some((topic) => !input.knowledge.some((body) => body.id === topic.id))) {
      packet.abstentions.push('subject-topic-body-not-admitted')
      continue
    }
    if (place.hours) add(subject, `place:${place.id}`, 'schedule', place.hours)
    const short = place.shortDescription ?? ''
    const long = place.longDescription ?? ''
    const body = long.includes(short) ? long : [short, long].filter(Boolean).join('\n')
    if (heightCue.test(body)) add(subject, `place:${place.id}`, 'height', body)
    for (const topic of input.knowledge)
      if (topic.id && identity(topic.title) === identity(place.name)) {
        if (heightCue.test(topic.content))
          add(subject, `knowledge:${topic.id}`, 'height', topic.content)
        if (/\b(?:hours|open|closed)\b/iu.test(topic.content))
          add(subject, `knowledge:${topic.id}`, 'schedule', topic.content)
      }
  }
  // An admitted attraction topic is itself a source identity. No fuzzy join to a place, no
  // first-40 inventory claim, no guessed taxonomy: only explicit published attraction categories.
  for (const topic of input.knowledge) {
    if (
      !topic.id ||
      !/^(?:attraction|ride|activity)$/iu.test(topic.category) ||
      !heightCue.test(topic.content)
    )
      continue
    const placeMatches = input.identityPlaces.filter(
      (place) => identity(place.name) === identity(topic.title),
    )
    if (placeMatches.length) continue // joined above only when its whole place body was admitted
    const sameTitles = (input.identityKnowledge ?? input.knowledge).filter(
      (row) => identity(row.title) === identity(topic.title),
    )
    if (sameTitles.length !== 1) {
      packet.abstentions.push('ambiguous-topic-subject')
      continue
    }
    add(
      { id: topic.id, name: topic.title, kind: 'knowledge' },
      `knowledge:${topic.id}`,
      'height',
      topic.content,
    )
  }
  const version = digest(JSON.stringify([...groups.values()]))
  const entries = [...groups.values()]
  if (entries.length > 24) packet.abstentions.push('subject-budget-partial')
  for (const group of entries.slice(0, 24)) {
    const result = buildGuestComputedFacts({
      ...input,
      resolvedSubject: group.subject,
      authorizedRecords: group.records,
      asOf: input.now,
      sourceVersion: version,
      timeZone: input.timeZone,
      coverage: { fresh: input.freshComplete, complete: input.freshComplete },
    })
    packet.omittedDays = Math.max(packet.omittedDays, result.omittedDays)
    packet.abstentions.push(...result.abstentions)
    packet.facts.push(...result.facts)
  }
  if (packet.facts.length > 32) {
    packet.facts = packet.facts.slice(0, 32)
    packet.abstentions.push('fact-budget-partial')
  }
  packet.abstentions = [...new Set(packet.abstentions)]
  packet.state = packet.facts.length
    ? packet.abstentions.length || packet.omittedDays
      ? 'partial'
      : 'known'
    : 'unknown'
  return packet
}
