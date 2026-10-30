/**
 * A conservative, server-computed "today status" cue for visitor chat.
 *
 * When a visitor implies coming or doing something today, the model must say first if the venue
 * is closed today. Prompt rules alone proved unreliable, so this module reads the venue's single
 * hours topic, and only when every schedule statement in it is recognised does it say that today
 * is (1) a closed weekday or closed date, (2) outside the season by explicit season wording or
 * outside the venue's own stated run dates, or
 * (3) after today's posted closing time. It never says that anything is open, and the cue is
 * scoped to the venue as a whole. Any doubt returns null: several hours topics, an outlet subject,
 * an unrecognised schedule sentence, variable holidays, weather or special-event wording, active
 * updates, a missing time zone, or today falling inside a stated exception period.
 *
 * The question gate and the hours grammar are English-only by design. Unrecognised language
 * simply yields no cue, which leaves the ordinary guide answer path unchanged.
 */

type KnowledgeTopic = { title: string; content: string; category?: string | null }
type ActiveUpdate = { title?: string | null; body?: string | null }

type Ymd = { y?: number; m: number; d: number }
type DateRange = { start: Ymd; end: Ymd }
type Interval = { open: number; close: number }
type OpenRule = { days: ReadonlySet<number>; times: Interval | null; range: DateRange | null }
type ClosedWeekdayRule = {
  days: ReadonlySet<number>
  season: string | null
  range: DateRange | null
}
type Schedule = {
  openRules: OpenRule[]
  closedWeekdays: ClosedWeekdayRule[]
  closedDates: Ymd[]
  operatingRanges: DateRange[]
  /** Explicit season boundaries: an "end" takes effect the day after the stated date. */
  seasonBounds: { key: number; kind: 'start' | 'end' }[]
  exceptRanges: DateRange[]
}

// Monday = 0 ... Sunday = 6, matching DAY_NAMES.
const DAY_NAMES = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
const MONTH_NAMES = [
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
const MONTH_ABBR: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
}
const DAY_RE = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)'
const MONTH_RE =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)'
const FIXED_HOLIDAYS: Record<string, { m: number; d: number }> = {
  'christmas day': { m: 12, d: 25 },
  'christmas eve': { m: 12, d: 24 },
  'boxing day': { m: 12, d: 26 },
  "new year's day": { m: 1, d: 1 },
  "new year's eve": { m: 12, d: 31 },
}
const GENERIC_SUBJECTS = new Set([
  'park',
  'venue',
  'zoo',
  'museum',
  'aquarium',
  'garden',
  'gardens',
  'centre',
  'center',
  'conservatory',
  'fair',
  'festival',
  'site',
  'attraction',
  'farm',
  'sanctuary',
  'reserve',
])
const PRONOUN_SUBJECTS = new Set(['', 'we', 'it'])

/** Words whose presence makes a sentence a schedule statement that must be fully recognised. */
const SCHEDULE_TOKEN = new RegExp(
  [
    `\\b${DAY_RE}s?\\b`,
    '\\b(?:january|february|march|april|june|july|august|september|october|november|december)\\b',
    '\\bmay\\s+\\d|\\d\\s+may\\b',
    '\\b(?:jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)\\.?\\s+\\d',
    '\\d\\s*(?:am|pm)\\b',
    '\\b\\d{1,2}:\\d{2}\\b',
    '\\b(?:open|opens|opening|reopen|reopens|closed|closes|closing|close|closure|closures|season|seasonal|daily|weekends?|weekdays|noon|midnight)\\b',
    '\\b(?:christmas|new year|boxing day|holiday|holidays)\\b',
  ].join('|'),
  'u',
)
/** Variable or open-ended wording the grammar never resolves; its presence refuses the topic. */
const REFUSE_WORDING =
  /\b(?:thanksgiving|easter|holiday|holidays|memorial day|labou?r day|independence day|juneteenth|good friday|bank holiday|half[- ]term|weather|temperature|special event|private event|subject to|varies|vary|may change|until further notice|by appointment|call ahead|temporarily|reduced hours|extended hours)\b/u

function normalizeText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[‐-―−]/gu, '-')
    .replace(/[‘’ʼ]/gu, "'")
    .replace(/\b([ap])\.m\.(?=\s+[A-Z])/gu, '$1m.')
    .replace(/\b([ap])\.m\./giu, '$1m')
    .replace(/[ \t]+/gu, ' ')
}

function daysInMonth(m: number, y?: number): number {
  if (m === 2) return y === undefined || (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 29 : 28
  return [4, 6, 9, 11].includes(m) ? 30 : 31
}

function monthOf(word: string): number | null {
  const w = word.replace(/\.$/u, '')
  const full = MONTH_NAMES.indexOf(w)
  if (full >= 0) return full + 1
  return MONTH_ABBR[w] ?? null
}

function weekdayOf(y: number, m: number, d: number): number {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

function clockMinutes(text: string): number | null {
  const t = text.trim()
  if (t === 'noon') return 12 * 60
  if (t === 'midnight') return 24 * 60
  let match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/u.exec(t)
  if (match) {
    const h = Number(match[1])
    const min = Number(match[2] ?? 0)
    if (h < 1 || h > 12 || min > 59) return null
    return (h % 12) * 60 + (match[3] === 'pm' ? 720 : 0) + min
  }
  match = /^(\d{1,2}):(\d{2})$/u.exec(t)
  if (match) {
    const h = Number(match[1])
    const min = Number(match[2])
    if (h > 24 || min > 59 || (h === 24 && min > 0)) return null
    return h * 60 + min
  }
  return null
}

function parseTimes(text: string): Interval | null {
  const t = text.trim().replace(/^from\s+/u, '')
  const match = /^(.+?)\s*(?:-|to|until|till)\s*(.+)$/u.exec(t)
  if (!match) return null
  const open = clockMinutes(match[1] ?? '')
  const close = clockMinutes(match[2] ?? '')
  // A closing time at or past midnight belongs to the next calendar day; leave that to the model.
  if (open === null || close === null || open >= close || close >= 24 * 60) return null
  return { open, close }
}

function parseDays(text: string): Set<number> | null {
  let t = text
    .trim()
    .replace(/\s+only$/u, '')
    .trim()
  if (/^(?:daily|every day|each day|all week|seven days a week|7 days a week)$/u.test(t))
    return new Set([0, 1, 2, 3, 4, 5, 6])
  t = t.replace(/^(?:on|from)\s+/u, '')
  if (/^(?:daily|every day|each day)$/u.test(t)) return new Set([0, 1, 2, 3, 4, 5, 6])
  if (/^(?:weekends?|saturdays and sundays|saturday and sunday)$/u.test(t)) return new Set([5, 6])
  if (/^weekdays$/u.test(t)) return new Set([0, 1, 2, 3, 4])
  t = t.replace(/^(?:every|each)\s+/u, '')
  const items = t.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/u)
  const result = new Set<number>()
  for (const item of items) {
    const range = new RegExp(
      `^(${DAY_RE})s?\\s*(?:-|to|through|thru|until)\\s*(${DAY_RE})s?$`,
      'u',
    ).exec(item)
    const single = new RegExp(`^(${DAY_RE})s?$`, 'u').exec(item)
    if (range) {
      const a = DAY_NAMES.indexOf(range[1] ?? '')
      const b = DAY_NAMES.indexOf(range[2] ?? '')
      for (let i = a; ; i = (i + 1) % 7) {
        result.add(i)
        if (i === b) break
      }
    } else if (single) result.add(DAY_NAMES.indexOf(single[1] ?? ''))
    else return null
  }
  return result.size ? result : null
}

/** A single date; a missing month is allowed only when `allowDayOnly` (the caller supplies it). */
function parseDate(text: string, allowDayOnly = false): (Partial<Ymd> & { d: number }) | null {
  let t = text.trim().replace(/,/gu, ' ').replace(/\s+/gu, ' ')
  let weekday: number | null = null
  const wd = new RegExp(`^(${DAY_RE})\\s+(.*)$`, 'u').exec(t)
  if (wd) {
    weekday = DAY_NAMES.indexOf(wd[1] ?? '')
    t = wd[2] ?? ''
  }
  let m: number | null = null
  let d: number
  let y: number | undefined
  let match = new RegExp(
    `^(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(\\d{4}))?$`,
    'u',
  ).exec(t)
  if (match) {
    m = monthOf(match[1] ?? '')
    d = Number(match[2])
    y = match[3] ? Number(match[3]) : undefined
  } else if (
    (match = new RegExp(
      `^(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_RE})\\.?(?:\\s+(\\d{4}))?$`,
      'u',
    ).exec(t))
  ) {
    d = Number(match[1])
    m = monthOf(match[2] ?? '')
    y = match[3] ? Number(match[3]) : undefined
  } else if (allowDayOnly && weekday === null && (match = /^(\d{1,2})(?:st|nd|rd|th)?$/u.exec(t))) {
    return { d: Number(match[1]) }
  } else return null
  if (!m || d < 1 || d > daysInMonth(m, y)) return null
  // A stated weekday that contradicts the stated date makes the line untrustworthy.
  if (weekday !== null && y !== undefined && weekdayOf(y, m, d) !== weekday) return null
  return y === undefined ? { m, d } : { y, m, d }
}

function completeRange(
  a: Partial<Ymd> & { d: number },
  b: Partial<Ymd> & { d: number },
): DateRange | null {
  const start = { ...a }
  const end = { ...b }
  if (start.m === undefined && end.m !== undefined) start.m = end.m
  if (end.m === undefined && start.m !== undefined) end.m = start.m
  if (start.m === undefined || end.m === undefined) return null
  const startMd = start.m * 100 + start.d
  const endMd = end.m * 100 + end.d
  if (start.y === undefined && end.y !== undefined) start.y = startMd > endMd ? end.y - 1 : end.y
  if (end.y === undefined && start.y !== undefined) end.y = endMd < startMd ? start.y + 1 : start.y
  if (start.d > daysInMonth(start.m, start.y) || end.d > daysInMonth(end.m, end.y)) return null
  const s = start as Ymd
  const e = end as Ymd
  if (s.y !== undefined && e.y !== undefined && ymdKey(s) > ymdKey(e)) return null
  return { start: s, end: e }
}

function parseDateRange(text: string): DateRange | null {
  const between = /^between\s/u.test(text.trim())
  const t = text
    .trim()
    .replace(/^(?:from|during|between|in)\s+/u, '')
    .replace(/\s+inclusive$/u, '')
    .trim()
  const monthRange = new RegExp(
    `^(${MONTH_RE})(?:\\s+(\\d{4}))?(?:\\s*(?:-|to|through|until)\\s*(${MONTH_RE})(?:\\s+(\\d{4}))?)?$`,
    'u',
  ).exec(t)
  if (monthRange) {
    const m1 = monthOf(monthRange[1] ?? '')
    const m2 = monthRange[3] ? monthOf(monthRange[3]) : m1
    if (!m1 || !m2) return null
    const y1 = monthRange[2] ? Number(monthRange[2]) : undefined
    const y2 = monthRange[4] ? Number(monthRange[4]) : monthRange[3] ? undefined : y1
    return completeRange(
      y1 === undefined ? { m: m1, d: 1 } : { y: y1, m: m1, d: 1 },
      y2 === undefined
        ? { m: m2, d: daysInMonth(m2, y2) }
        : { y: y2, m: m2, d: daysInMonth(m2, y2) },
    )
  }
  // "and" joins a range only after "between"; elsewhere it lists separate dates.
  const separatorRe = between
    ? /\s*(?:-|\bto\b|\bthrough\b|\bthru\b|\buntil\b|\band\b)\s*/gu
    : /\s*(?:-|\bto\b|\bthrough\b|\bthru\b|\buntil\b)\s*/gu
  const separators = [...t.matchAll(separatorRe)]
  const results: DateRange[] = []
  for (const sep of separators) {
    const index = sep.index ?? 0
    const a = parseDate(t.slice(0, index), true)
    const b = parseDate(t.slice(index + sep[0].length), true)
    if (!a || !b || (a.m === undefined && b.m === undefined)) continue
    const range = completeRange(a, b)
    if (range) results.push(range)
  }
  return results.length === 1 ? (results[0] ?? null) : null
}

function parseDateList(text: string): Ymd[] | null {
  const protectedText = text
    .replace(/,\s*(\d{4})\b/gu, ' $1')
    .replace(new RegExp(`\\b(${DAY_RE}),\\s*`, 'gu'), '$1 ')
  const items = protectedText
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/u)
    .map((item) => item.trim())
  const parsed: (Partial<Ymd> & { d: number })[] = []
  for (const item of items) {
    const holiday = FIXED_HOLIDAYS[item]
    if (holiday) {
      parsed.push({ ...holiday })
      continue
    }
    const date = parseDate(item, true)
    if (!date) return null
    parsed.push(date)
  }
  // "24 and 25 December 2026": a bare day takes the month and year of the next full date.
  for (let i = parsed.length - 1; i >= 0; i--) {
    const item = parsed[i]
    const next = parsed[i + 1]
    if (!item) return null
    if (item.m === undefined) {
      if (!next || next.m === undefined) return null
      item.m = next.m
      if (item.y === undefined && next.y !== undefined) item.y = next.y
    }
  }
  const lastYear = parsed[parsed.length - 1]?.y
  return parsed.map((item) => {
    const y = item.y ?? lastYear
    return y === undefined
      ? { m: item.m as number, d: item.d }
      : { y, m: item.m as number, d: item.d }
  })
}

type PartMeaning = { days?: Set<number>; times?: Interval; range?: DateRange }

/** Decomposes "daily from 10:00 to 18:00 during October 2026" into days, times and range. */
function parsePart(part: string): PartMeaning | null {
  const words = part.trim().split(/\s+/u)
  const found = new Set<string>()
  let meaning: PartMeaning | null = null
  for (let i = 0; i <= words.length; i++) {
    for (let j = i; j <= words.length; j++) {
      const chunks = [words.slice(0, i), words.slice(i, j), words.slice(j)]
        .map((chunk) => chunk.join(' '))
        .filter(Boolean)
      const candidate: PartMeaning = {}
      let ok = chunks.length > 0
      for (const chunk of chunks) {
        const days = parseDays(chunk)
        const times = days ? null : parseTimes(chunk)
        const range = days || times ? null : parseDateRange(chunk)
        if (days && !candidate.days) candidate.days = days
        else if (times && !candidate.times) candidate.times = times
        else if (range && !candidate.range) candidate.range = range
        else ok = false
      }
      if (!ok) continue
      const key = JSON.stringify({
        ...candidate,
        days: candidate.days ? [...candidate.days] : null,
      })
      found.add(key)
      meaning = candidate
    }
  }
  return found.size === 1 ? meaning : null
}

function splitParts(body: string): string[] {
  return body
    .replace(/,\s*(\d{4})\b/gu, ' $1')
    .replace(new RegExp(`\\b(${DAY_RE}),\\s*(?=${MONTH_RE}|\\d)`, 'gu'), '$1 ')
    .split(/\s*,\s*/u)
    .reduce<string[]>((parts, part) => {
      // "10am-4pm Monday, Tuesday and Friday": a pure weekday piece continues the previous list.
      const previous = parts[parts.length - 1]
      const pureDays = new RegExp(`^(?:and\\s+)?${DAY_RE}s?(?:\\s+(?:and|&)\\s+${DAY_RE}s?)?$`, 'u')
      if (previous && pureDays.test(part) && new RegExp(`${DAY_RE}s?$`, 'u').test(previous))
        parts[parts.length - 1] = `${previous}, ${part}`
      else parts.push(part)
      return parts
    }, [])
    .map((part) => part.replace(/^and\s+/u, '').trim())
    .filter(Boolean)
}

function parseOpenBody(body: string, scope: DateRange | null): OpenRule[] | null {
  const trimmed = body.replace(
    /,?\s*(?:with\s+)?(?:last|final)\s+(?:paid\s+)?(?:entry|admission)\b[^,]*$/u,
    '',
  )
  const parts = splitParts(trimmed).map(parsePart)
  if (parts.some((part) => !part)) return null
  const meanings = parts as PartMeaning[]
  const ranges = meanings.filter((part) => part.range)
  if (ranges.length > 1 || (ranges.length === 1 && scope)) return null
  const range = ranges[0]?.range ?? scope
  const combos = meanings.filter((part) => part.days && part.times)
  const loneDays = meanings.filter((part) => part.days && !part.times)
  const loneTimes = meanings.filter((part) => part.times && !part.days)
  if (combos.length) {
    if (loneDays.length || loneTimes.length) return null
    return combos.map((part) => ({
      days: part.days as Set<number>,
      times: part.times as Interval,
      range,
    }))
  }
  if (loneDays.length !== 1 || loneTimes.length > 1) return null
  return [{ days: loneDays[0]?.days as Set<number>, times: loneTimes[0]?.times ?? null, range }]
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(?:the|our)\s+/u, '')
    .replace(/^\d{4}\s+/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

type SubjectKind = { ok: false } | { ok: true; generic: string | null }

function subjectKind(
  raw: string | undefined,
  venueName: string | undefined,
  allowGeneric: boolean,
): SubjectKind {
  const s = normalizeName(raw ?? '')
  if (PRONOUN_SUBJECTS.has(s)) return { ok: true, generic: null }
  if (venueName && s === normalizeName(normalizeText(venueName))) return { ok: true, generic: null }
  if (allowGeneric && GENERIC_SUBJECTS.has(s)) return { ok: true, generic: s }
  return { ok: false }
}

function ymdKey(value: Ymd): number {
  return (value.y ?? 0) * 10000 + value.m * 100 + value.d
}

function inRange(date: Required<Ymd>, range: DateRange): boolean {
  if (range.start.y !== undefined && range.end.y !== undefined) {
    const key = ymdKey(date)
    return key >= ymdKey(range.start) && key <= ymdKey(range.end)
  }
  const md = date.m * 100 + date.d
  const start = range.start.m * 100 + range.start.d
  const end = range.end.m * 100 + range.end.d
  return start <= end ? md >= start && md <= end : md >= start || md <= end
}

function hasYears(range: DateRange): boolean {
  return range.start.y !== undefined && range.end.y !== undefined
}

/** Parses the whole hours topic, or returns null when any schedule statement is not understood. */
export function parseVenueSchedule(content: string, venueName?: string): Schedule | null {
  const schedule: Schedule = {
    openRules: [],
    closedWeekdays: [],
    closedDates: [],
    operatingRanges: [],
    seasonBounds: [],
    exceptRanges: [],
  }
  const seasons = new Map<string, DateRange>()
  const pendingSeasonClosures: { rule: ClosedWeekdayRule; season: string }[] = []
  const generics = new Set<string>()
  const lines = normalizeText(content)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !/^source(?: url)?\s*:/iu.test(line))

  const addClosed = (bodyText: string): boolean => {
    let body = bodyText.trim().replace(/^on\s+/u, '')
    const except = /,?\s*except\s+(?:from\s+|between\s+|on\s+)?(.+?)(?:,\s*when\b.*)?$/u.exec(body)
    let exceptRange: DateRange | null = null
    if (except) {
      exceptRange = parseDateRange(except[1] ?? '')
      if (!exceptRange) return false
      body = body.slice(0, except.index).trim()
    }
    const forSeason = /^for the season (after|from|since|on) (.+)$/u.exec(body)
    if (forSeason) {
      const date = parseDate(forSeason[2] ?? '')
      if (!date || date.m === undefined || date.y === undefined || exceptRange) return false
      const ymd = { y: date.y, m: date.m, d: date.d }
      schedule.seasonBounds.push({
        key: ymdKey(forSeason[1] === 'after' ? addDays(ymd, 1) : ymd),
        kind: 'end',
      })
      return true
    }
    let season: string | null = null
    const seasonMatch = /\s+(?:in|during) the ([a-z]+) season$/u.exec(body)
    if (seasonMatch) {
      season = seasonMatch[1] ?? null
      body = body.slice(0, seasonMatch.index).trim()
    }
    const part = parsePart(body)
    if (part?.days && !part.times && part.days.size < 7) {
      if (season && part.range) return false
      const rule: ClosedWeekdayRule = { days: part.days, season, range: part.range ?? null }
      schedule.closedWeekdays.push(rule)
      if (season) pendingSeasonClosures.push({ rule, season })
      if (exceptRange) schedule.exceptRanges.push(exceptRange)
      return true
    }
    if (season) return false
    const dates = parseDateList(body)
    if (!dates) return false
    schedule.closedDates.push(...dates)
    if (exceptRange) schedule.exceptRanges.push(exceptRange)
    return true
  }

  const acceptSubject = (raw: string | undefined, allowGeneric: boolean): boolean => {
    const kind = subjectKind(raw, venueName, allowGeneric)
    if (!kind.ok) return false
    if (kind.generic) generics.add(kind.generic === 'garden' ? 'gardens' : kind.generic)
    return true
  }

  for (const line of lines) {
    const clauses = line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/u).flatMap((sentence) => {
      // A labeled sentence ("Hours: ...; ...") keeps its label on every semicolon segment.
      const label = /^(hours|open|opening hours|closed)\s*:\s*(.*)$/iu.exec(sentence)
      return label
        ? (label[2] ?? '').split(/\s*;\s*/u).map((clause) => `${label[1]}: ${clause}`)
        : sentence.split(/\s*;\s*/u)
    })
    for (const rawClause of clauses) {
      let clause = rawClause
        .trim()
        .replace(/[.!]+$/u, '')
        .trim()
        .toLowerCase()
      if (!clause) continue
      if (REFUSE_WORDING.test(clause.replace(/,?\s*except\s.*$/u, ''))) return null
      if (!SCHEDULE_TOKEN.test(clause)) continue
      if (
        /^(?:general |the )?(?:last|final) (?:paid )?(?:entry|admission|admittance)\b/u.test(clause)
      )
        continue
      if (
        /\b(?:are|is|have|has) not (?:yet )?(?:been )?(?:announced|published|set)(?: yet)?$/u.test(
          clause,
        ) &&
        !/\b(?:open|closed)\b/u.test(clause)
      )
        continue

      let scope: DateRange | null = null
      const seasonLabel = /^(?:the )?([a-z]+) season \(([^)]*)\):\s*(.*)$/u.exec(clause)
      if (seasonLabel) {
        scope = parseDateRange(seasonLabel[2] ?? '')
        if (!scope || seasons.has(seasonLabel[1] ?? '')) return null
        seasons.set(seasonLabel[1] ?? '', scope)
        clause = seasonLabel[3] ?? ''
      }

      const labeled = /^(hours|open|opening hours|closed):\s*(.*)$/u.exec(clause)
      if (labeled) {
        // Commas after a weekday or before a year are part of a date, not a subject separator.
        let body = (labeled[2] ?? '')
          .replace(new RegExp(`\\b(${DAY_RE}),\\s*(?=${MONTH_RE}\\b|\\d)`, 'gu'), '$1 ')
          .replace(/,\s*(\d{4})\b/gu, ' $1')
        // "Hours: Museum, ..." names a subject; only the venue's own name counts as venue-wide.
        const firstComma = body.indexOf(',')
        if (
          firstComma > 0 &&
          !parsePart(body.slice(0, firstComma)) &&
          !parseDateList(body.slice(0, firstComma))
        ) {
          if (!acceptSubject(body.slice(0, firstComma), false)) return null
          body = body.slice(firstComma + 1).trim()
        }
        if (labeled[1] === 'closed') {
          if (!addClosed(body)) return null
        } else {
          const rules = parseOpenBody(body, scope)
          if (!rules) return null
          schedule.openRules.push(...rules)
        }
        continue
      }

      // Only explicit season wording, never the edge of a posted date range, proves a closure:
      // a zoo whose posted hours end May 28 has unknown, not closed, hours afterwards.
      const seasonBound =
        /^(?:the |our )?(?:(\d{4}) )?season (ended|ends|will end|closed|closes|opens|opened|begins|began|starts|started|will open|reopens) (?:on )?(.+)$/u.exec(
          clause,
        )
      if (seasonBound && !scope) {
        const date = parseDate(seasonBound[3] ?? '')
        const y = date?.y ?? (seasonBound[1] ? Number(seasonBound[1]) : undefined)
        if (!date || date.m === undefined || y === undefined) return null
        if (date.y !== undefined && seasonBound[1] && date.y !== Number(seasonBound[1])) return null
        const ymd = { y, m: date.m, d: date.d }
        const isEnd = /^(?:ended|ends|will end|closed|closes)$/u.test(seasonBound[2] ?? '')
        schedule.seasonBounds.push(
          isEnd
            ? { key: ymdKey(addDays(ymd, 1)), kind: 'end' }
            : { key: ymdKey(ymd), kind: 'start' },
        )
        continue
      }

      const runs = /^(.+?) (?:runs|is on|takes place) (?:from )?(.+)$/u.exec(clause)
      if (runs && !scope) {
        const range = parseDateRange(runs[2] ?? '')
        if (!range || !acceptSubject(runs[1], true)) return null
        schedule.operatingRanges.push(range)
        continue
      }

      const closed = /^(?:(.*?)\s+)?(?:(?:is|are)\s+)?closed\s+(.+)$/u.exec(clause)
      if (closed && !/\b(?:open|opens)\b/u.test(clause.replace(/,?\s*except\s.*$/u, ''))) {
        if (!acceptSubject(closed[1], true) || !addClosed(closed[2] ?? '')) return null
        continue
      }

      const open =
        /^(?:opening hours|regular hours|hours) (?:are|is) (.+)$/u.exec(clause) ??
        /^(?:(.*?)\s+)?(?:(?:is|are)\s+)?(?:open|opens)\s+(.+)$/u.exec(clause)
      if (open) {
        const subject = open.length === 3 ? open[1] : ''
        const body = open.length === 3 ? open[2] : open[1]
        if (!acceptSubject(subject, true)) return null
        const rules = parseOpenBody(body ?? '', scope)
        if (!rules) return null
        schedule.openRules.push(...rules)
        continue
      }
      return null
    }
  }
  if (generics.size > 1) return null
  for (const { rule, season } of pendingSeasonClosures) {
    const range = seasons.get(season)
    if (!range) return null
    rule.range = range
  }
  const scoped = schedule.openRules.filter((rule) => rule.range).length
  if (scoped && scoped !== schedule.openRules.length) return null
  if (
    !schedule.openRules.length &&
    !schedule.operatingRanges.length &&
    !schedule.seasonBounds.length
  )
    return null
  return schedule
}

type DayStatus =
  | { kind: 'unknown' }
  | { kind: 'closed-date' }
  | { kind: 'closed-weekday'; season: string | null }
  | { kind: 'not-operating-day' }
  | { kind: 'out-of-season' }
  | { kind: 'open'; times: Interval | null; yearful: boolean }

function seasonClosed(schedule: Schedule, date: Required<Ymd>): boolean {
  const key = ymdKey(date)
  const events = [...schedule.seasonBounds].sort((a, b) => a.key - b.key)
  const latest = events.filter((event) => event.key <= key).at(-1)
  if (latest) return latest.kind === 'end'
  return events[0]?.kind === 'start'
}

function dayStatus(schedule: Schedule, date: Required<Ymd>): DayStatus {
  if (schedule.exceptRanges.some((range) => inRange(date, range))) return { kind: 'unknown' }
  const yearlessRanges = [
    ...schedule.openRules.flatMap((rule) =>
      rule.range && !hasYears(rule.range) ? [rule.range] : [],
    ),
    ...schedule.operatingRanges.filter((range) => !hasYears(range)),
  ]
  // An annual range ending February 28 says nothing reliable about February 29.
  if (date.m === 2 && date.d === 29 && yearlessRanges.length) return { kind: 'unknown' }
  if (
    schedule.closedDates.some(
      (c) => c.m === date.m && c.d === date.d && (c.y === undefined || c.y === date.y),
    )
  )
    return { kind: 'closed-date' }
  const weekday = weekdayOf(date.y, date.m, date.d)
  const weekly = schedule.closedWeekdays.find(
    (rule) => rule.days.has(weekday) && (!rule.range || inRange(date, rule.range)),
  )
  const applicable = schedule.openRules.filter((rule) => !rule.range || inRange(date, rule.range))
  const todays = applicable.filter((rule) => rule.days.has(weekday))
  if (weekly)
    return todays.length ? { kind: 'unknown' } : { kind: 'closed-weekday', season: weekly.season }
  const afterSeasonEnd = seasonClosed(schedule, date)
  const outsideRuns =
    schedule.operatingRanges.length > 0 &&
    !schedule.operatingRanges.some((range) => inRange(date, range))
  const coveredByYearfulRule = applicable.some((rule) => rule.range && hasYears(rule.range))
  if (afterSeasonEnd && coveredByYearfulRule) return { kind: 'unknown' }
  if (afterSeasonEnd || outsideRuns) return { kind: 'out-of-season' }
  if (!schedule.openRules.length) return { kind: 'unknown' }
  // Outside every posted range without explicit season wording: hours are unknown, not closed.
  if (!applicable.length) return { kind: 'unknown' }
  if (!todays.length) return { kind: 'not-operating-day' }
  const intervals = new Set(
    todays.map((rule) => (rule.times ? `${rule.times.open}-${rule.times.close}` : 'none')),
  )
  if (intervals.size !== 1) return { kind: 'unknown' }
  const yearful =
    todays.every((rule) => rule.range && hasYears(rule.range)) ||
    schedule.operatingRanges.some((range) => hasYears(range) && inRange(date, range))
  return { kind: 'open', times: todays[0]?.times ?? null, yearful }
}

function addDays(date: Required<Ymd>, days: number): Required<Ymd> {
  const next = new Date(Date.UTC(date.y, date.m - 1, date.d + days))
  return { y: next.getUTCFullYear(), m: next.getUTCMonth() + 1, d: next.getUTCDate() }
}

function formatClock(minutes: number): string {
  if (minutes === 12 * 60) return 'noon'
  const h = Math.floor(minutes / 60)
  const min = minutes % 60
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}${min ? `:${String(min).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`
}

function formatDate(date: Required<Ymd>, withYear: boolean): string {
  const weekday = DAY_NAMES[weekdayOf(date.y, date.m, date.d)] ?? ''
  const month = MONTH_NAMES[date.m - 1] ?? ''
  const cap = (value: string) => value.charAt(0).toUpperCase() + value.slice(1)
  return `${cap(weekday)}, ${cap(month)} ${date.d}${withYear ? `, ${date.y}` : ''}`
}

function nextOpening(schedule: Schedule, today: Required<Ymd>): string | null {
  for (let offset = 1; offset <= 400; offset++) {
    const date = addDays(today, offset)
    const status = dayStatus(schedule, date)
    if (status.kind === 'unknown') return null
    if (status.kind !== 'open') continue
    // A date far ahead is only "posted" when an explicit-year range states it.
    if (offset > 14 && !status.yearful) return null
    const when = formatDate(date, date.y !== today.y)
    return status.times ? `${when} at ${formatClock(status.times.open)}` : when
  }
  return null
}

function venueLocalNow(
  now: Date,
  timeZone: string,
): { date: Required<Ymd>; minute: number } | null {
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    )
    const date = { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) }
    const minute = (Number(parts.hour) % 24) * 60 + Number(parts.minute)
    if (![date.y, date.m, date.d, minute].every(Number.isFinite)) return null
    return { date, minute }
  } catch {
    return null
  }
}

const OTHER_TIME =
  /\b(?:tomorrow|yesterday|next|last (?:week|month|year|time|summer|winter)|weekend|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays|january|february|march|april|may\s+\d{1,2}|\d{1,2}\s+may|\d{4}-\d{2}-\d{2}|june|july|august|september|october|november|december|christmas|thanksgiving|easter|holiday|holidays|summer|winter|spring|autumn|later this|someday|in (?:a|two|three|\d+) (?:days?|weeks?|months?)|\d{1,2}(?:st|nd|rd|th)|\d{1,2}\/\d{1,2}|came|visited|went|last visit|usually|normally|in general|ever)\b/u
const TODAY_WORDS =
  /\b(?:today|tonight|right now|now|this (?:morning|afternoon|evening)|currently|at the moment)\b/u
const ARRIVAL_WORDS =
  /\b(?:when (?:i|we) (?:arrive|get (?:there|here|in)|come in|show up|visit|are there|'re there)|when we're there|on (?:my|our) way|(?:i'm|i am|we're|we are) (?:coming|heading|driving|arriving|visiting|going there|here|at the (?:gate|entrance|parking))|just arrived|coming in|heading (?:over|there|in)|(?:on|upon) arrival)\b/u
const PLAN_WORDS =
  /\b(?:(?:planning|plan|hoping|want|wanting|going) to (?:visit|come|go there|stop by|drop by|head (?:over|there))|can (?:i|we) (?:borrow|rent|hire|buy|book|reserve|pick up))\b/u

/**
 * True when the question implies visiting or doing something today, including arrival or plan
 * wording without the word "today" (the server clock supplies today's date). English-only and
 * conservative: any other day, date, season or past-visit wording turns the gate off.
 */
export function guestTodayStatusQuestion(question: string): boolean {
  const q = normalizeText(question).toLowerCase()
  if (!q.trim() || q.length > 500 || OTHER_TIME.test(q)) return false
  return TODAY_WORDS.test(q) || ARRIVAL_WORDS.test(q) || PLAN_WORDS.test(q)
}

function isHoursTopic(topic: KnowledgeTopic): boolean {
  return (
    /^hours$/iu.test(topic.category?.trim() ?? '') ||
    /\b(?:hours|opening hour|opening times?|operating (?:calendar|days|hours)|opening and closing)\b/iu.test(
      topic.title,
    )
  )
}

const CUE_TAIL =
  'If the visitor plans to come or do something today, say this first and plainly, then answer the rest. Do not tell the visitor that anything is currently open. This is the venue-wide schedule; an individual outlet, event or service with its own posted schedule may differ. Do not infer holiday or special-event changes.'

/** Returns a short trusted cue that the venue is closed today or done for the day, or null. */
export function guestTodayStatusCue(params: {
  question: string
  now: Date
  timeZone: string | undefined
  knowledge: ReadonlyArray<KnowledgeTopic>
  activeUpdates?: ReadonlyArray<ActiveUpdate>
  venueName?: string
}): string | null {
  if (!params.timeZone || params.activeUpdates?.length) return null
  if (!guestTodayStatusQuestion(params.question)) return null
  const topics = params.knowledge.filter(isHoursTopic)
  if (topics.length !== 1 || !topics[0]) return null
  const local = venueLocalNow(params.now, params.timeZone)
  if (!local) return null
  const schedule = parseVenueSchedule(topics[0].content, params.venueName)
  if (!schedule) return null
  const status = dayStatus(schedule, local.date)
  const today = formatDate(local.date, true)
  const head = `TODAY'S POSTED VENUE STATUS (server check of the venue's posted hours): Today is ${today}.`
  const weekdayName = formatDate(local.date, false).split(',')[0] ?? ''
  if (
    status.kind === 'closed-date' ||
    status.kind === 'closed-weekday' ||
    status.kind === 'not-operating-day'
  ) {
    const why =
      status.kind === 'closed-date'
        ? 'its posted hours list today as a closed date'
        : status.kind === 'closed-weekday'
          ? `its posted hours say it is closed on ${weekdayName}s${status.season ? ` in the ${status.season} season` : ''}`
          : `its posted hours list no opening on ${weekdayName}s at this time of year`
    const next = nextOpening(schedule, local.date)
    return `${head} The venue is closed today: ${why}.${next ? ` Its next posted opening is ${next}.` : ''} ${CUE_TAIL}`
  }
  if (status.kind === 'out-of-season') {
    const next = nextOpening(schedule, local.date)
    return `${head} The venue is closed today: its posted season or run dates do not include today.${next ? ` Its next posted opening is ${next}.` : ' The posted hours give no next opening date.'} ${CUE_TAIL}`
  }
  if (status.kind === 'open' && status.times && local.minute >= status.times.close) {
    const next = nextOpening(schedule, local.date)
    return `${head} The venue's posted hours for today (${formatClock(status.times.open)} to ${formatClock(status.times.close)}) have ended, so it is closed for the rest of today.${next ? ` Its next posted opening is ${next}.` : ''} ${CUE_TAIL}`
  }
  return null
}

/** GUEST_CHAT_TODAY_STATUS=on adds the cue to the visitor prompt. Off by default. */
export function guestTodayStatusEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GUEST_CHAT_TODAY_STATUS?.trim().toLowerCase() === 'on'
}
