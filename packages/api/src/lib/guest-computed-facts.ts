/** Optional computation over ONE admitted source snapshot. No fetching or publication authority.
 * Deliberately narrow English grammar: unsupported clauses abstain on the entire subject.
 * Calendar dates are ISO YYYY-MM-DD; the existing schedule evaluator uses Monday=0 internally.
 */
import { dayStatus, parseVenueSchedule, venueLocalNow } from './guest-today-status'
import { createHash } from 'node:crypto'

export type ComputedFactsMode = 'off' | 'schedule' | 'height' | 'all'
export type ComputedSubject = { id: string; name: string; kind: 'venue' | 'place' }
export type ComputedRecord = {
  key: string
  subjectId: string
  kind: 'schedule' | 'height'
  content: string
  version: string
}
type Provenance = {
  subjectId: string
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
type HeightFact = { kind: 'height'; status: HeightStatus; riderHeight: string; raw: string }
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

/** Explicit dates keep their year. Bare weekdays mean the next occurrence including today.
 * "next Friday", holidays, yearless month dates, requested clock times and ranges abstain.
 */
export function resolveRequestedDays(input: { question: string; now: Date; timeZone: string }): {
  dates: string[]
  omittedDays: number
  reason?: string
} {
  const unknown = (reason: string) => ({ dates: [], omittedDays: 0, reason })
  const local = venueLocalNow(input.now, input.timeZone)
  if (!local) return unknown('invalid-clock-or-zone')
  const q = input.question.toLowerCase()
  if (
    q.length > 500 ||
    /\b(?:next|last|yesterday|holiday|christmas|easter|thanksgiving|weekend|week|month|year|until|through|between)\b|\d\s*(?:am|pm)\b|\d:\d/u.test(
      q,
    )
  )
    return unknown('ambiguous-date-or-time')
  const dates: string[] = []
  let remainder = q.replace(/\b\d{4}-\d{2}-\d{2}\b/gu, (match) => {
    dates.push(fromIso(match) ? match : 'invalid')
    return ''
  })
  const namedDate = new RegExp(
    `\\b(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})\\b`,
    'gu',
  )
  remainder = remainder.replace(namedDate, (_match, month: string, day: string, year: string) => {
    const value = iso({ y: Number(year), m: months.indexOf(month) + 1, d: Number(day) })
    dates.push(fromIso(value) ? value : 'invalid')
    return ''
  })
  if (new RegExp(`\\b(?:${months.join('|')})\\b|\\d`, 'u').test(remainder))
    return unknown('unresolved-date')
  const today = iso(local.date)
  const todayWeekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7
  const namedDays = weekdays.filter((day) => new RegExp(`\\b${day}\\b`, 'u').test(remainder))
  for (const day of namedDays)
    dates.push(offsetDay(today, (weekdays.indexOf(day) - todayWeekday + 7) % 7))
  if (/\btomorrow\b/u.test(remainder)) dates.push(offsetDay(today, 1))
  if (/\b(?:today|tonight|now|currently)\b/u.test(remainder)) dates.push(today)
  if (!dates.length && /\b(?:hours|open|opening|closed|closing)\b/u.test(q)) dates.push(today)
  if (dates.includes('invalid')) return unknown('invalid-date')
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
}): ScheduleFact | { status: 'unknown'; reason: string } {
  if (input.content.length > 5_000) return { status: 'unknown', reason: 'schedule-budget' }
  const schedule = parseVenueSchedule(scheduleContent(input.content), input.subjectName, {
    allowGenericSubjects: false,
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
type HeightRule = { raw: string; state: 'known' | 'unknown'; minimum?: Length; maximum?: Length }
type HeightStatus = 'below_minimum' | 'height_condition_met' | 'above_maximum' | 'unknown'

/** Only a complete plain height condition. Companion, age, health, uncertain clauses stay unresolved. */
export function parseHeightRule(raw: string): HeightRule {
  const value = raw
    .trim()
    .replace(/^height:\s*/iu, '')
    .replace(/[.]$/u, '')
    .trim()
  const unknown: HeightRule = { raw, state: 'unknown' }
  const min =
    /^(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)\s*(?:minimum|to ride)$/iu.exec(value) ??
    /^(?:minimum|min)\s*(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)$/iu.exec(value)
  if (min) {
    const minimum = length(min[1]!, min[2]!.toLowerCase())
    return minimum ? { raw, state: 'known', minimum } : unknown
  }
  const range =
    /^(\d{1,3}(?:\.\d{1,6})?)\s*(?:to|-)\s*(\d{1,3}(?:\.\d{1,6})?)\s*(in|inches|inch|cm)$/iu.exec(
      value,
    )
  if (!range) return unknown
  const minimum = length(range[1]!, range[3]!.toLowerCase())
  const maximum = length(range[2]!, range[3]!.toLowerCase())
  return minimum && maximum && compare(minimum, maximum) <= 0
    ? { raw, state: 'known', minimum, maximum }
    : unknown
}

export function compareRiderHeight(rule: HeightRule, height: string): { status: HeightStatus } {
  const rider = measurement(height)
  if (!rider || rule.state !== 'known' || !rule.minimum) return { status: 'unknown' }
  if (compare(rider, rule.minimum) < 0) return { status: 'below_minimum' }
  if (rule.maximum && compare(rider, rule.maximum) > 0) return { status: 'above_maximum' }
  return { status: 'height_condition_met' }
}

function riderMeasurement(question: string): string | null {
  // Reject multiple measurements/dimensions rather than select the first number or infer an age.
  if (/\b(?:children|kids|riders|tower|track|drop|tallest)\b/iu.test(question)) return null
  const matches = [
    ...question.matchAll(
      /\b\d{1,3}(?:\.\d{1,6})?\s*(?:(?:ft|feet|foot)\s*\d{1,2}(?:\.\d{1,6})?\s*(?:inches|inch|in)|(?:inches|inch|in|cm))\b/giu,
    ),
  ]
  if (matches.length !== 1) return null
  // Other numerical values could be another rider, age or dimension: do not bind them implicitly.
  const remaining = question.replace(matches[0]![0], '')
  return /\d/u.test(remaining) ? null : matches[0]![0]
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
        })
        if ('reason' in result) packet.abstentions.push(result.reason)
        else packet.facts.push({ ...result, ...provenance(schedules) })
      }
    }
  }
  if (input.mode === 'height' || input.mode === 'all') {
    const height = riderMeasurement(input.question)
    const sources = records.filter((row) => row.kind === 'height')
    // Whole eligibility body is parsed, never extract a settled line and discard other conditions.
    const bodies = [...new Set(sources.map((row) => row.content.trim()))]
    if (!height || bodies.length !== 1) packet.abstentions.push('ambiguous-rider-or-rule')
    else {
      const raw = bodies[0]!
      const result = compareRiderHeight(parseHeightRule(raw), height)
      if (result.status === 'unknown') packet.abstentions.push('unresolved-height-conditions')
      else
        packet.facts.push({
          kind: 'height',
          ...result,
          riderHeight: height,
          raw,
          ...provenance(sources),
        })
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
          kind: fact.kind,
          riderHeight: fact.riderHeight,
          status: fact.status,
          rule: fact.raw,
        }
      : {
          subject: fact.subjectName,
          kind: fact.kind,
          date: fact.date,
          status: fact.status,
          openMinute: fact.open,
          closeMinute: fact.close,
          nextOpening: fact.nextOpening,
          searchHorizonDays: fact.searchHorizonDays,
        },
  )
  return `COMPUTED POSTED FACTS: ${JSON.stringify(facts)}\nThese are conditions from admitted posted records, not live verification. Height condition met is not unconditional ride permission. Missing facts and missing next openings remain unknown. Minutes are local minutes after midnight. Use only the named subject and date; retain all ordinary source limitations.`
}

type PromptPlace = {
  id?: string
  name: string
  hours: string | null
  shortDescription: string | null
  longDescription: string | null
}
type PromptKnowledge = { id?: string; title: string; category: string; content: string }
const identity = (value: string) =>
  value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Small router adapter: only finally admitted whole bodies enter this function.
 * Exact authorized names identify a place; a generic venue question uses a closed grammar.
 * We do not resolve unknown facilities from venue-wide hours or use a names-only index as proof.
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
  const empty = (reason: string): ComputedPacket => ({
    state: 'unknown',
    facts: [],
    abstentions: [reason],
    omittedDays: 0,
  })
  if (input.mode === 'off') return empty('off')
  if (!input.timeZone || !input.freshComplete || input.identityAmbiguous)
    return empty('untrusted-or-ambiguous-snapshot')
  const question = ` ${identity(input.question)} `
  const named = input.identityPlaces.filter((place) =>
    question.includes(` ${identity(place.name)} `),
  )
  if (named.length > 1) return empty('ambiguous-subject')
  let subject: ComputedSubject
  const records: ComputedRecord[] = []
  const add = (key: string, kind: ComputedRecord['kind'], content: string) => {
    records.push({ key, kind, content, subjectId: subject.id, version: digest(content) })
  }
  if (named.length === 1 && named[0]?.id) {
    const matched = input.places.filter((place) => place.id === named[0]!.id)
    if (matched.length !== 1) return empty('subject-body-not-admitted')
    const place = matched[0]!
    subject = { id: place.id!, name: place.name, kind: 'place' }
    const matchingTopics = (input.identityKnowledge ?? input.knowledge).filter(
      (topic) => identity(topic.title) === identity(place.name),
    )
    if (matchingTopics.some((topic) => !input.knowledge.some((body) => body.id === topic.id)))
      return empty('subject-topic-body-not-admitted')
    if (place.hours) add(`place:${place.id}`, 'schedule', place.hours)
    const body = [place.shortDescription, place.longDescription].filter(Boolean).join('\n')
    if (/\bheight\s*:/iu.test(body)) add(`place:${place.id}`, 'height', body)
    // A whole topic with exactly the unique authorized place's name is scoped to that place.
    for (const topic of input.knowledge) {
      if (topic.id && identity(topic.title) === identity(place.name)) {
        if (/\bheight\s*:/iu.test(topic.content))
          add(`knowledge:${topic.id}`, 'height', topic.content)
        if (/\b(?:hours|open|closed)\b/iu.test(topic.content))
          add(`knowledge:${topic.id}`, 'schedule', topic.content)
      }
    }
  } else {
    // Remove only the exact venue name and known temporal/schedule vocabulary. Any remaining
    // noun ("cafe", "garden annex", "it") makes the intended subject unresolved.
    let remainder = question.replace(` ${identity(input.venue.name)} `, ' ')
    remainder = remainder
      .replace(
        new RegExp(
          `\\b(?:${weekdays.join('|')}|${months.join('|')}|today|tomorrow|tonight|now|currently|hours|open|opens|opening|closed|closes|closing|when|what|are|is|the|you|your|on|at|and|please|time|times|do|does|will|be)\\b|\\d+`,
          'gu',
        ),
        '',
      )
      .trim()
    if (remainder) return empty('unresolved-subject')
    subject = { id: input.venue.id, name: input.venue.name, kind: 'venue' }
    const isHours = (topic: { title: string; category: string }) =>
      /^hours$/iu.test(topic.category) || /\b(?:hours|opening times?)\b/iu.test(topic.title)
    const candidates = (input.identityKnowledge ?? input.knowledge).filter(isHours)
    if (candidates.some((topic) => !input.knowledge.some((body) => body.id === topic.id)))
      return empty('hours-body-not-admitted')
    for (const topic of input.knowledge) {
      if (topic.id && isHours(topic)) add(`knowledge:${topic.id}`, 'schedule', topic.content)
    }
  }
  return buildGuestComputedFacts({
    ...input,
    resolvedSubject: subject,
    authorizedRecords: records,
    asOf: input.now,
    sourceVersion: digest(JSON.stringify(records)),
    timeZone: input.timeZone,
    coverage: { fresh: input.freshComplete, complete: input.freshComplete },
  })
}
