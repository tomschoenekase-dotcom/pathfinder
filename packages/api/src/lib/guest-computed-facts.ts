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
  const q = input.question
    .normalize('NFKC')
    .replace(/[‐-―−]/gu, '-')
    .toLowerCase()
  if (
    q.length > 500 ||
    /\b(?:next|last|yesterday|holiday|christmas|easter|thanksgiving|weekends?|weeks?|months?|years?|until|through|between|noon|midnight|midday|morning|afternoon|evening|tonight|later|soon)\b|\d\s*(?:am|pm)\b|\d:\d/u.test(
      q,
    ) ||
    /\b(?:in|after|within|before)\s+(?:\d+(?:\.\d+)?|[a-z]+(?:[ -][a-z]+){0,3})\s*\b(?:days?|weeks?|months?|years?|hours?|minutes?)\b|\b(?:days?|hours?|minutes?)\s+(?:from now|later|ago)\b|\bday after tomorrow\b|\b(?:at|around|about|by)\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/u.test(
      q,
    )
  )
    return unknown('ambiguous-date-or-time')
  const dates: string[] = []
  const namedDate = `(?:${months.join('|')})\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}`
  const dateTokens = [
    ...q.matchAll(
      new RegExp(
        `\\b(?:(?<weekday>${weekdays.join('|')})(?:\\s*,\\s*|\\s+))?(?<date>\\d{4}-\\d{2}-\\d{2}|${namedDate})\\b`,
        'gu',
      ),
    ),
  ]
  let remainder = q
  for (let index = dateTokens.length - 1; index >= 0; index--) {
    const token = dateTokens[index]!
    const start = token.index!
    const next = dateTokens[index + 1]
    if (
      next &&
      /-|\b(?:to|through|thru|until)\b/u.test(q.slice(start + token[0].length, next.index))
    )
      return unknown('unsupported-date-range')
    const rawDate = token.groups!.date!
    const named = new RegExp(
      `^(${months.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})$`,
      'u',
    ).exec(rawDate)
    const value = named
      ? iso({ y: Number(named[3]), m: months.indexOf(named[1]!) + 1, d: Number(named[2]) })
      : rawDate
    const date = fromIso(value)
    if (!date) return unknown('invalid-date')
    const weekday = (new Date(Date.UTC(date.y, date.m - 1, date.d)).getUTCDay() + 6) % 7
    if (token.groups!.weekday && weekdays[weekday] !== token.groups!.weekday)
      return unknown('contradictory-weekday-date')
    dates.unshift(value)
    remainder =
      remainder.slice(0, start) +
      ' '.repeat(token[0].length) +
      remainder.slice(start + token[0].length)
  }
  if (
    new RegExp(`\\b(?:${months.join('|')})\\b`, 'u').test(remainder) ||
    /\d/u.test(remainder) ||
    /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b|\b\d{1,2}[/-]\d{1,2}\b|\b(?:19|20|21)\d{2}\b/u.test(
      remainder,
    )
  )
    return unknown('unresolved-date')
  if (/\b(?:at|around|about|by|after|before|within)\b/u.test(remainder))
    return unknown('unresolved-temporal-modifier')
  const today = iso(local.date)
  const todayWeekday = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7
  const namedDays = weekdays.filter((day) => new RegExp(`\\b${day}\\b`, 'u').test(remainder))
  const temporalSpans = [
    ...dateTokens.map((token) => ({ start: token.index!, end: token.index! + token[0].length })),
    ...[
      ...remainder.matchAll(new RegExp(`\\b(?:today|tomorrow|${weekdays.join('|')})\\b`, 'gu')),
    ].map((token) => ({ start: token.index!, end: token.index! + token[0].length })),
  ].sort((a, b) => a.start - b.start)
  if (
    temporalSpans.some(
      (span, index) =>
        index > 0 &&
        /^\s*(?:-|to|through|thru|until)\s*$/u.test(
          q.slice(temporalSpans[index - 1]!.end, span.start),
        ),
    )
  )
    return unknown('unsupported-date-range')
  // An unconsumed weekday beside an explicit date may be an unsupported qualifier. Never
  // silently add another visit day. Fully qualified multi-date lists were consumed above.
  if (dates.length && namedDays.length) return unknown('unbound-weekday-date')
  if (
    new RegExp(
      `\\b(?:${weekdays.join('|')})\\s*(?:-|to)\\s*(?:${weekdays.join('|')})\\b`,
      'u',
    ).test(remainder)
  )
    return unknown('unsupported-date-range')
  for (const day of namedDays)
    dates.push(offsetDay(today, (weekdays.indexOf(day) - todayWeekday + 7) % 7))
  if (/\btomorrow\b/u.test(remainder)) dates.push(offsetDay(today, 1))
  if (/\b(?:today|now|currently)\b/u.test(remainder)) dates.push(today)
  // Only a bare neutral hours/status request has a safe implicit-today default. Merely finding
  // "open" anywhere in a longer unresolved request must never supply a missing date.
  if (!dates.length && /^(?:open|closed|hours|opening hours)[?!. ]*$/u.test(q.trim()))
    dates.push(today)
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

function riderMeasurements(question: string): string[] {
  // Values are compared separately; no binding to age, identity, or first-number selection.
  const q = question.normalize('NFKC').replace(/[‐-―−]/gu, '-')
  if (q.length > 500 || /\b(?:tower|track|drop|tallest|speed|length)\b/iu.test(q)) return []
  // Consume no endpoint from a range, signed value, fraction or uncertain estimate. These
  // describe a set/bound rather than the exact scalar required by the comparison contract.
  if (
    /[+~±<>≤≥]|[-/⁄]\s*\d|(?<!\d)\.\d|\d,\d|\b(?:between|about|around|approximately|approximate|approx|roughly|nearly|almost|under|over|below|above|maybe|perhaps|possibly|estimated|estimate|minus|plus|negative|positive)\b|\b(?:at least|at most|up to|less than|more than)\b|\d(?:\.\d+)?\s*(?:(?:inches|inch|in|cm)\s*)?(?:to|through|thru|until|or)\s*\d|\d\s+and\s+\d\s*(?:ft|feet|foot)\b/iu.test(
      q,
    )
  )
    return []
  if (/\d\s*['′]\s*\d|\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s*(?:inches|inch|in|cm)\b/iu.test(q)) return []
  const shared =
    /(?<![\p{L}\p{N}.,])(\d{1,3}(?:\.\d{1,6})?)\s+and\s+(\d{1,3}(?:\.\d{1,6})?)\s*(inches|inch|in|cm)\b/giu
  const heights: string[] = []
  const rest = q.replace(shared, (_match, first, second, unit) => {
    heights.push(`${first} ${unit}`, `${second} ${unit}`)
    return ''
  })
  const scalarExpression =
    /(?<![\p{L}\p{N}.,])\d{1,3}(?:\.\d{1,6})?\s*(?:(?:ft|feet|foot)\s*\d{1,2}(?:\.\d{1,6})?\s*(?:inches|inch|in)|(?:inches|inch|in|cm))\b/giu
  const matches = [...rest.matchAll(scalarExpression)]
  heights.push(...matches.map((match) => match[0]))
  const unparsed = rest.replace(scalarExpression, '')
  if (/\b(?:ft|feet|foot|inches|inch|cm)\b/iu.test(unparsed)) return []
  return heights.length <= 8 ? [...new Set(heights)] : []
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
