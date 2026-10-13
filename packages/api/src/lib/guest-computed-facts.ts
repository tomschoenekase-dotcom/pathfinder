/**
 * Server-computed facts for the guest prompt. Lighter models write well from a stated fact but
 * are unreliable at calendar arithmetic and height comparisons, so this module does that work
 * deterministically from the venue's own records. It never invents a schedule: a day the records
 * do not cover is left out, and every line keeps the record's own wording beside the verdict.
 */
import { guestRequestedCalendarDays } from './guest-knowledge-retrieval'
import { guestRideFacts } from './guest-ride-facts'

type HoursRecord = { title: string; category: string; content: string }
type DirectoryLike = { knowledge: ReadonlyArray<HoursRecord> }

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
] as const
const MONTH_RE =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?'
const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const
const WEEKDAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?s?'
const DASH = '\\s*(?:-|–|—|to|through|thru)\\s*'
const TIME_RE =
  '(?:(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)|(noon|midday|midnight))'
const DAY_NUM = '(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)'
const YEAR = '(?:,?\\s*(\\d{4}))?'

/** A calendar day in the venue's own zone. */
export type VenueDay = { year: number; month: number; day: number; weekday: number }

function monthIndex(term: string): number {
  return MONTHS.findIndex((m) => m.startsWith(term.toLowerCase().replace('.', '').slice(0, 3)))
}
function weekdayIndex(term: string): number {
  return WEEKDAYS.findIndex((d) => d.startsWith(term.toLowerCase().slice(0, 3)))
}
function dayValue(d: Pick<VenueDay, 'year' | 'month' | 'day'>) {
  return d.year * 10_000 + (d.month + 1) * 100 + d.day
}
export function venueDay(year: number, month: number, day: number): VenueDay {
  const date = new Date(Date.UTC(year, month, day))
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    weekday: date.getUTCDay(),
  }
}
function addDays(d: VenueDay, n: number) {
  return venueDay(d.year, d.month, d.day + n)
}
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  return 1 + ((weekday - venueDay(year, month, 1).weekday + 7) % 7) + (n - 1) * 7
}
function lastWeekday(year: number, month: number, weekday: number) {
  const last = venueDay(year, month + 1, 0)
  return last.day - ((last.weekday - weekday + 7) % 7)
}
function easter(year: number) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const h =
    (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  return venueDay(
    year,
    Math.floor((h + l - 7 * m + 114) / 31) - 1,
    ((h + l - 7 * m + 114) % 31) + 1,
  )
}
const HOLIDAY_NAMES = [
  "new year's day",
  'new years day',
  "new year's eve",
  'christmas eve',
  'christmas day',
  'thanksgiving day',
  'thanksgiving',
  'memorial day',
  'labor day',
  'easter',
  'independence day',
  'fourth of july',
  'halloween',
]
/** Named holidays a schedule line can use, resolved for one day. */
function holidaysOn(d: VenueDay): string[] {
  const names: string[] = []
  const is = (month: number, day: number) => d.month === month && d.day === day
  if (is(0, 1)) names.push("new year's day", 'new years day')
  if (is(11, 31)) names.push("new year's eve")
  if (is(6, 4)) names.push('independence day', 'fourth of july')
  if (is(9, 31)) names.push('halloween')
  if (is(11, 24)) names.push('christmas eve')
  if (is(11, 25)) names.push('christmas day', 'christmas')
  if (d.month === 10 && d.day === nthWeekday(d.year, 10, 4, 4))
    names.push('thanksgiving day', 'thanksgiving')
  if (d.month === 4 && d.day === lastWeekday(d.year, 4, 1)) names.push('memorial day')
  if (d.month === 8 && d.day === nthWeekday(d.year, 8, 1, 1)) names.push('labor day')
  const e = easter(d.year)
  if (d.month === e.month && d.day === e.day) names.push('easter')
  return names
}

type Clause = {
  ranges: Array<[number, number]>
  dates: number[]
  weekdays: Set<number> | null
  holidays: string[]
  otherDates: boolean
}

/** The date ranges, single dates, weekly days and holidays one schedule segment names. */
function parseClause(text: string, year: number): Clause {
  const ranges: Array<[number, number]> = []
  const dates: number[] = []
  // A weekday printed beside a date only labels that date ("Monday, October 12").
  // Only a singular weekday labels a date; "Saturdays, October 3-24" is a weekly rule, and a
  // weekday after a dash ends a weekday range ("Saturday-Monday, October 10-12").
  const wdLabel = '(?:(?<![-–—]\\s?)\\b(?:sun|mon|tues?|wednes|thurs?|fri|satur)day(?!s)\\b,?\\s+)?'
  let rest = text.toLowerCase()
  const rangeRe = new RegExp(
    `${wdLabel}${MONTH_RE}\\s+${DAY_NUM}${YEAR}${DASH}${wdLabel}(?:${MONTH_RE}\\s+)?${DAY_NUM}${YEAR}`,
    'giu',
  )
  rest = rest.replace(rangeRe, (...m: string[]) => {
    const m1 = monthIndex(m[1]!)
    const m2 = m[4] ? monthIndex(m[4]) : m1
    const y2 = Number(m[6] ?? m[3] ?? year)
    const y1 = Number(m[3] ?? (m2 < m1 ? y2 - 1 : y2))
    if (m1 >= 0 && m2 >= 0)
      ranges.push([
        dayValue({ year: y1, month: m1, day: Number(m[2]) }),
        dayValue({ year: y2, month: m2, day: Number(m[5]) }),
      ])
    return ' '
  })
  rest = rest.replace(
    new RegExp(`${wdLabel}${MONTH_RE}\\s+${DAY_NUM}${YEAR}`, 'giu'),
    (...m: string[]) => {
      const mi = monthIndex(m[1]!)
      if (mi >= 0)
        dates.push(dayValue({ year: Number(m[3] ?? year), month: mi, day: Number(m[2]) }))
      return ' '
    },
  )
  let weekdays: Set<number> | null = null
  if (/\b(daily|every day|each day)\b/u.test(rest)) weekdays = new Set([0, 1, 2, 3, 4, 5, 6])
  else {
    const set = new Set<number>()
    if (/\bweekends?\b/u.test(rest)) [0, 6].forEach((d) => set.add(d))
    if (/\bweekdays\b/u.test(rest)) [1, 2, 3, 4, 5].forEach((d) => set.add(d))
    const leftover = rest.replace(
      new RegExp(`\\b${WEEKDAY_RE}${DASH}${WEEKDAY_RE}\\b`, 'giu'),
      (...m: string[]) => {
        const a = weekdayIndex(m[1]!)
        const b = weekdayIndex(m[2]!)
        if (a >= 0 && b >= 0)
          for (let i = a; ; i = (i + 1) % 7) {
            set.add(i)
            if (i === b) break
          }
        return ' '
      },
    )
    for (const m of leftover.matchAll(new RegExp(`\\b${WEEKDAY_RE}\\b`, 'giu'))) {
      const i = weekdayIndex(m[1]!)
      if (i >= 0) set.add(i)
    }
    weekdays = set.size ? set : null
  }
  return {
    ranges,
    dates,
    weekdays,
    holidays: HOLIDAY_NAMES.filter((h) => rest.includes(h)),
    otherDates: /\bother dates\b|\ball other\b/u.test(rest),
  }
}

/** true: the segment covers this day; false: it names days and this is not one; null: no days named. */
function clauseApplies(c: Clause, d: VenueDay): boolean | null {
  const v = dayValue(d)
  if (c.holidays.length && holidaysOn(d).some((h) => c.holidays.includes(h))) return true
  if (c.dates.includes(v)) return true
  const inRange = c.ranges.length ? c.ranges.some(([a, b]) => v >= a && v <= b) : null
  const weekdayOk = c.weekdays ? c.weekdays.has(d.weekday) : null
  if (inRange === false) return false
  if (inRange === true) return weekdayOk ?? true
  if (c.dates.length || c.holidays.length) return false
  return weekdayOk
}

type TimeRange = { start: number | null; end: number | null; label: string }
function minutes(h?: string, mm?: string, ap?: string, word?: string) {
  if (word) return /midnight/iu.test(word) ? 24 * 60 : 12 * 60
  return ((Number(h) % 12) + (/p/iu.test(ap!) ? 12 : 0)) * 60 + Number(mm ?? 0)
}
function parseTimes(text: string): TimeRange[] {
  const out: TimeRange[] = []
  for (const m of text.matchAll(new RegExp(`${TIME_RE}${DASH}${TIME_RE}`, 'giu'))) {
    let start = minutes(m[1], m[2], m[3], m[4])
    let end = minutes(m[5], m[6], m[7], m[8])
    if (start === 24 * 60) start = 0
    if (end <= start) end += 24 * 60
    out.push({ start, end, label: m[0].replace(/\s+/gu, ' ').trim() })
  }
  if (out.length) return out
  const opens = new RegExp(`opens?\\s+at\\s+${TIME_RE}`, 'iu').exec(text)
  if (opens)
    return [{ start: minutes(opens[1], opens[2], opens[3], opens[4]), end: null, label: opens[0] }]
  if (/dawn\s*(?:-|–|—|to)\s*dusk/iu.test(text))
    return [{ start: null, end: null, label: 'dawn to dusk' }]
  return []
}
function clock(min: number) {
  const m = ((min % 1440) + 1440) % 1440
  if (m === 720) return 'noon'
  if (m === 0) return 'midnight'
  const h = Math.floor(m / 60)
  return `${h % 12 || 12}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`
}

type Line = {
  record: string
  facility: string
  closed: boolean
  text: string
  clause: Clause
  times: TimeRange[]
}

const HOURS_RECORD = /\b(hours|calendar|schedule|opening|operating)\b/iu
const GENERIC_RECORD =
  /^(hours( and operating calendar)?|opening hours|operating calendar|hours of operation)$/iu
const NOT_A_FACILITY =
  /^(\d|other|all |every|daily|today|the following|these|times|hours|closed|open|season)/iu
function facilityOf(segment: string, record: string) {
  const forMatch = /\bfor\s+([^.;]+?)(?:[.;]|$)/iu.exec(segment)
  if (
    forMatch &&
    !/\b(today|visit|members|everyone|guests|the season|confirm)\b/iu.test(forMatch[1]!)
  )
    return forMatch[1]!.trim()
  const subject =
    /^(?:[Hh]ours\s*:\s*)?([A-Z][\w’'&. ]{2,40}?)\s+(?:opens|is open|runs|operates)\b/u.exec(
      segment,
    )
  if (subject) return subject[1]!.trim()
  const closedSubject = new RegExp(
    `^closed\\s*:\\s*([^,]+?)[,\\s]+(?:${WEEKDAY_RE}\\b|${MONTH_RE}\\s+\\d|every\\b|on\\b)`,
    'iu',
  ).exec(segment)
  if (closedSubject && !NOT_A_FACILITY.test(closedSubject[1]!) && !/\d/u.test(closedSubject[1]!))
    return closedSubject[1]!.trim()
  const labelled = /^(?:hours|closed)\s*:\s*([^,]+?),\s/iu.exec(segment)
  if (
    labelled &&
    !NOT_A_FACILITY.test(labelled[1]!) &&
    !/\d|\bnoon\b|\bmidnight\b/iu.test(labelled[1]!) &&
    !new RegExp(`\\b${WEEKDAY_RE}\\b|^${MONTH_RE}\\s`, 'iu').test(labelled[1]!)
  )
    return labelled[1]!.trim()
  const title = record
    .replace(
      /\s+\b(january|february|march|april|may|june|july|august|september|october|november|december)\b.*$/iu,
      '',
    )
    .replace(/\b(\d{4}|hours?)\b/giu, '')
    .trim()
  return GENERIC_RECORD.test(record.trim()) || !title ? 'the venue' : title
}
function scheduleLines(directory: DirectoryLike, year: number): Line[] {
  const lines: Line[] = []
  for (const record of directory.knowledge) {
    if (!HOURS_RECORD.test(record.title) && !/^hours$/iu.test(record.category)) continue
    for (const raw of record.content.split(/\n+|(?<=\.)\s+(?=[A-Z])/u)) {
      const line = raw.trim()
      const label = /^(hours|closed)\s*:/iu.exec(line)?.[1]?.toLowerCase()
      const segments = line.split(/;\s*/u)
      let facility: string | null = null
      for (const [i, seg] of segments.entries()) {
        const text = i === 0 ? seg : label ? `${label}: ${seg}` : seg
        const closed = label === 'closed' || (!label && /\bclosed\b(?!\s+(?:at|by))/iu.test(text))
        const times = closed ? [] : parseTimes(text)
        if (!closed && !times.length) continue
        const own = facilityOf(i === 0 ? text : seg.match(/\bfor\s/iu) ? seg : text, record.title)
        facility = own !== 'the venue' || !facility ? own : facility
        lines.push({
          record: record.title,
          facility,
          closed,
          text: text.trim(),
          clause: parseClause(text, year),
          times,
        })
      }
    }
  }
  return lines
}
const sameFacility = (a: string, b: string) => {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.includes(y) || y.includes(x) || x === 'the venue' || y === 'the venue'
}

export type DayStatus = { lines: string[] }
/** What the hours records say for one venue day. Specific closures override regular hours. */
export function guestScheduleForDay(
  directory: DirectoryLike,
  d: VenueDay,
  nowMinutes: number | null,
): DayStatus {
  const all = scheduleLines(directory, d.year)
  const open = all.filter((l) => !l.closed && clauseApplies(l.clause, d) === true)
  const closed = all.filter((l) => {
    if (!l.closed || clauseApplies(l.clause, d) !== true) return false
    return !l.clause.otherDates || !open.some((o) => o.record === l.record)
  })
  const out: string[] = []
  const byFacility = new Map<string, Line[]>()
  for (const l of open) {
    if (closed.some((c) => sameFacility(c.facility, l.facility))) continue
    byFacility.set(l.facility, [...(byFacility.get(l.facility) ?? []), l])
  }
  for (const [facility, ls] of byFacility) {
    const seen = new Set<string>()
    const times = ls.flatMap((l) => l.times).filter((t) => !seen.has(t.label) && seen.add(t.label))
    const desc = times.map((t) => t.label).join(' and ')
    const ranges = times.filter((t) => t.start !== null)
    if (nowMinutes !== null && times.length === 1 && times[0]!.label === 'dawn to dusk') {
      // Exact dawn and dusk are unknown; only clear daylight or clear night gets a verdict.
      const verdict =
        nowMinutes >= 21 * 60 || nowMinutes < 5 * 60
          ? 'closed now, since it is after dusk'
          : nowMinutes >= 10 * 60 && nowMinutes < 16 * 60
            ? 'open now by the schedule (daylight)'
            : 'open only until dusk; the exact dusk time is not in the records'
      out.push(`${facility}: ${desc}, ${verdict}`)
      continue
    }
    if (nowMinutes === null || !ranges.length || ranges.length !== times.length) {
      out.push(`${facility}: ${desc}`)
      continue
    }
    const current = ranges.find(
      (t) => nowMinutes >= t.start! && (t.end === null || nowMinutes < t.end),
    )
    const next = ranges.filter((t) => t.start! > nowMinutes).sort((a, b) => a.start! - b.start!)[0]
    const status = current
      ? current.end !== null
        ? `open now by the schedule, until ${clock(current.end)}`
        : `opened at ${clock(current.start!)}`
      : next
        ? `not open yet; opens at ${clock(next.start!)}`
        : 'closed for the rest of today'
    out.push(`${facility}: ${desc}, ${status}`)
  }
  const closedSeen = new Set<string>()
  for (const c of closed) {
    if (closedSeen.has(c.facility)) continue
    closedSeen.add(c.facility)
    out.push(
      `${c.facility === 'the venue' ? 'Closed' : `${c.facility}: closed`} this day (${c.text})`,
    )
  }
  return { lines: out }
}

function localNow(now: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  )
  return {
    day: venueDay(Number(parts.year), Number(parts.month) - 1, Number(parts.day)),
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  }
}
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1)
const fmt = (d: VenueDay) =>
  `${cap(WEEKDAYS[d.weekday]!)}, ${cap(MONTHS[d.month]!)} ${d.day}, ${d.year}`

const SCHEDULE_QUESTION =
  /\b(open|opens|opening|close|closes|closed|closing|hours?|today|tonight|tomorrow|now|weekend|when|late|early|schedule|visit|plan|go|come)\b/iu

/** Days the visitor asks about: today, tomorrow, named weekdays, explicit dates and holidays. */
function askedDays(question: string, today: VenueDay, currentDate: string): VenueDay[] {
  const days = [today]
  const q = question.toLowerCase()
  if (/\btomorrow\b/u.test(q)) days.push(addDays(today, 1))
  for (const m of q.matchAll(new RegExp(`\\b(this |next |on )?${WEEKDAY_RE}\\b`, 'giu'))) {
    const w = weekdayIndex(m[2]!)
    if (w < 0) continue
    const ahead = (w - today.weekday + 7) % 7
    // A weekday that is today means today ("this Saturday" on a Saturday); "next" means a week out.
    days.push(ahead === 0 && m[1]?.trim() !== 'next' ? today : addDays(today, ahead || 7))
  }
  for (const anchor of guestRequestedCalendarDays(question, currentDate)) {
    const [month, day] = anchor.split(' ')
    const mi = monthIndex(month!)
    if (mi >= 0) days.push(venueDay(today.year + (mi < today.month - 6 ? 1 : 0), mi, Number(day)))
  }
  for (const h of [
    'christmas',
    'thanksgiving',
    "new year's day",
    'easter',
    'memorial day',
    'labor day',
    'halloween',
    'fourth of july',
  ])
    if (q.includes(h))
      for (let i = 0; i < 400; i++) {
        const d = addDays(today, i)
        if (holidaysOn(d).includes(h)) {
          days.push(d)
          break
        }
      }
  const seen = new Set<number>()
  return days.filter((d) => !seen.has(dayValue(d)) && seen.add(dayValue(d))).slice(0, 8)
}

/** The next day within two weeks that has scheduled hours. */
function nextOpening(directory: DirectoryLike, from: VenueDay, facility?: string) {
  for (let i = 1; i <= 14; i++) {
    const d = addDays(from, i)
    const open = guestScheduleForDay(directory, d, null).lines.filter(
      (l) => !/ this day \(/u.test(l) && (!facility || l.startsWith(`${facility}:`)),
    )
    if (open.length) return `${fmt(d)}: ${open.join('; ')}`
  }
  return null
}

export function guestScheduleFacts(input: {
  question: string
  directory: DirectoryLike
  now: Date
  timeZone?: string | null | undefined
}): string | null {
  if (!input.timeZone) return null
  const { day: today, minutes: nowMin } = localNow(input.now, input.timeZone)
  const currentDate = `${today.year}-${String(today.month + 1).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`
  const namesADay =
    guestRequestedCalendarDays(input.question, currentDate).length > 0 ||
    new RegExp(`\\b${WEEKDAY_RE}\\b`, 'iu').test(input.question)
  if (!SCHEDULE_QUESTION.test(input.question) && !namesADay) return null
  const dayLines: string[] = []
  for (const d of askedDays(input.question, today, currentDate)) {
    const isToday = dayValue(d) === dayValue(today)
    const { lines } = guestScheduleForDay(input.directory, d, isToday ? nowMin : null)
    if (!lines.length) continue
    const allClosed = lines.every((l) => / this day \(/u.test(l))
    const nexts = allClosed
      ? [nextOpening(input.directory, d)].filter(Boolean).map((n) => `Next scheduled hours: ${n}`)
      : lines
          .map((l) => /^(.+): closed this day \(/u.exec(l)?.[1])
          .filter((f): f is string => Boolean(f))
          .map((f) => {
            const n = nextOpening(input.directory, d, f)
            return n ? `${f} next opens ${n}` : null
          })
          .filter(Boolean)
    dayLines.push(
      `${isToday ? `Today, ${fmt(d)}, now ${clock(nowMin)}` : fmt(d)}: ${lines.join('; ')}${nexts.length ? `. ${nexts.join('. ')}` : ''}`,
    )
  }
  if (!dayLines.length) return null
  return `SERVER-COMPUTED SCHEDULE (worked out from the hours records; scheduled hours, not a live check). Use it for open, closed and next-opening answers instead of calculating them yourself. A day or place not listed here is not covered by the records.\n${dayLines.join('\n')}`
}

type HeightRule = {
  minAlone: number | null
  minWithCompanion: number | null
  noMinimum: boolean
  max: number | null
  text: string
}
/** Reads one ride record's Height line; forms it cannot read return null rather than a guess. */
export function parseHeightRule(content: string): HeightRule | null {
  const matches = [...content.matchAll(/height:\s*([^\n|]+)/giu)]
  if (matches.length !== 1) return null
  const text = matches[0]![1]!.trim()
  const l = text.toLowerCase()
  const num = (re: RegExp) => {
    const m = re.exec(l)
    return m ? Number(m[1]) : null
  }
  const noMinimum = /no (?:numerical )?minimum/u.test(l)
  const max = num(/(\d{2,3})\s*(?:in|")\s*(?:child-rider\s+)?maximum/u)
  let minAlone = num(/(\d{2,3})\s*(?:in|")\s*to ride alone/u)
  let minWithCompanion = num(/(\d{2,3})\s*(?:in|")\s*(?:minimum\s*)?with (?:a|an) /u)
  const minimum = num(/(\d{2,3})\s*(?:in|")\s*minimum/u)
  const companionUnder =
    num(/(?:under|below)\s*(\d{2,3})\s*(?:in|")\s*(?:require|must|need|ride with|with)/u) ??
    num(/between \d{2,3} and (\d{2,3})\s*(?:in|")\s*require/u)
  if (minimum !== null && minWithCompanion === null) {
    if (companionUnder !== null && companionUnder > minimum) {
      minWithCompanion = minimum
      minAlone = companionUnder
    } else if (minAlone === null) minAlone = minimum
  }
  if (minAlone !== null && minWithCompanion === null && /smaller riders?/u.test(l))
    minWithCompanion = 0
  if (noMinimum && companionUnder !== null && minAlone === null) minAlone = companionUnder
  if (minAlone === null && minWithCompanion === null && !noMinimum) return null
  return {
    minAlone,
    minWithCompanion: minWithCompanion ?? (noMinimum ? 0 : null),
    noMinimum,
    max,
    text,
  }
}
const SEASON_CLOSED =
  /closed for (?:the )?(?:\d{4} )?season|season (?:has )?ended|not operating|reinstallation|no (?:confirmed )?reopening/iu
function heightInInches(question: string): number | null {
  const q = question.toLowerCase()
  const feet = /(\d)\s*(?:ft|feet|foot|')\s*(\d{1,2})?\s*(?:in\b|inches|")?/u.exec(q)
  if (feet) return Number(feet[1]) * 12 + Number(feet[2] ?? 0)
  const inches = /(\d{2,3})\s*(?:-?\s*inch(?:es)?\b|in\b|")/u.exec(q)
  if (inches) return Number(inches[1])
  const cm = /(\d{2,3})\s*cm\b/u.exec(q)
  return cm ? Math.round(Number(cm[1]) / 2.54) : null
}
const AGE_ONLY =
  /\b(\d{1,2})[- ]?(?:year|yr)s?[- ]?olds?\b|\b(?:is|turns?|aged?|age)\s+(\d{1,2})\b/iu

/** Height comparisons for every ride with exactly one readable Height line. */
export function guestHeightFacts(directory: DirectoryLike, question: string): string | null {
  const h = heightInInches(question)
  if (h === null && !AGE_ONLY.test(question)) return null
  const rides = directory.knowledge
    .map((k) => ({
      title: k.title,
      rule: parseHeightRule(k.content),
      closed: SEASON_CLOSED.test(k.content),
    }))
    .filter((r) => r.rule)
  if (!rides.length) return null
  const tag = (r: { closed: boolean }) =>
    r.closed ? ' (not currently operating per its record)' : ''
  if (h === null)
    return `SERVER-COMPUTED RIDE HEIGHTS: only an age was given, so no height comparison is possible. Rides with no minimum height (companion rules still apply): ${
      rides
        .filter((r) => r.rule!.noMinimum)
        .map((r) => `${r.title}${tag(r)}`)
        .join(', ') || 'none recorded'
    }. Every other ride depends on the child's measured height.`
  const lines = rides.map((ride) => {
    const r = ride.rule!
    const name = `${ride.title}${tag(ride)}`
    if (r.max !== null && h > r.max) return `${name}: over the ${r.max}-inch maximum`
    if (r.minWithCompanion !== null && r.minWithCompanion > 0 && h < r.minWithCompanion)
      return `${name}: too short, ${r.minWithCompanion - h} in under the ${r.minWithCompanion}-inch minimum`
    if (r.minAlone !== null && h < r.minAlone)
      return r.minWithCompanion !== null
        ? `${name}: only with a qualifying companion (${r.minAlone} in to ride alone)`
        : `${name}: too short, ${r.minAlone - h} in under the ${r.minAlone}-inch minimum`
    return `${name}: meets the height rule`
  })
  return `SERVER-COMPUTED RIDE HEIGHTS for a ${h}-inch rider (from each ride's Height line; age, companion and health rules still apply): ${lines.join('; ')}.`
}

/** The computed-facts block appended to the dynamic prompt, or '' when nothing applies. */
export function buildGuestComputedFacts(input: {
  question: string
  /** The visitor's previous message, so a follow-up such as "who made it" keeps its subject. */
  previousQuestion?: string | null
  directory: DirectoryLike
  now: Date
  timeZone?: string | null | undefined
  /** Research harnesses turn this off to measure the other facts alone. */
  rideFacts?: boolean
}): string {
  return [
    guestScheduleFacts(input),
    guestHeightFacts(input.directory, input.question),
    input.rideFacts !== false &&
      guestRideFacts({
        question: input.previousQuestion
          ? `${input.previousQuestion}\n${input.question}`
          : input.question,
        directory: input.directory,
      }),
  ]
    .filter(Boolean)
    .join('\n\n')
}
