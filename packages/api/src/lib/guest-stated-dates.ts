// Calendar dates written in a record's own text, for the neutral "stated dates passed" marker.
// The title-year rule (guest-event-dates.ts) only reads years in titles; authored venue records
// put their dates in the body ("Hours: daily, 10 am to 4 pm, September 8, 2026 to May 28,
// 2027"), so a schedule, event or price period whose dates have all passed is otherwise served
// with no server signal. This never hides a record. It marks one only when every date it can
// read is before today, nothing names a later year, no month appears without a year (an
// undated or yearly schedule such as "opens May–October") and no date opens an open-ended
// period ("Starting March 1, 2026, parking is $10" stays unmarked after March 1).

import { hasNearYearSign } from './guest-event-dates'

export const GUEST_STATED_DATES_VERSION = 'guest-stated-dates-v1'

export const GUEST_STATED_DATES_RULE =
  'A topic marked stated_dates_passed writes no calendar date after the one shown, and that date is before today. Anything it limits to its stated dates (an event, a season, a dated schedule, a price or offer period) is over: never present those as current or upcoming. Details it gives without any date are not affected. If the visitor needs current dates, hours or prices the topic no longer covers, say they are not posted and suggest checking with the venue.'

export function guestStatedDatesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.GUEST_CHAT_STATED_DATES?.trim().toLowerCase() === 'on'
}

const MONTHS: Record<string, number> = {
  January: 1,
  February: 2,
  March: 3,
  April: 4,
  May: 5,
  June: 6,
  July: 7,
  August: 8,
  September: 9,
  October: 10,
  November: 11,
  December: 12,
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Sept: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
}
// Capitalized month names only: lower-case "may" is a verb. Full names come first so the
// alternation never stops at an abbreviation inside a full name.
const MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December|Sept|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\.?'
const WEEKDAY =
  '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Tues|Wed|Thu|Thurs|Fri|Sat|Sun)\\.?'
const DAY = '\\d{1,2}(?:st|nd|rd|th)?'
const YEAR = '(?:19|20)\\d{2}'
const SEPARATOR = '(?:,|to|through|thru|until|till|-|–|—|and|&|or)'
const LIST_SEPARATOR = '(?:,|and|&|or|to|through|thru|until|-|–|—)'
// "October 1 to October 31, 2026", "Oct. 24 & 25, 2026", "Saturday, October 24, and Sunday,
// October 25, 2026". The year closes the span and dates every month/day pair inside it.
const MONTH_DAY_SPAN = new RegExp(
  `\\b${MONTH}\\s+${DAY}(?:\\s*${SEPARATOR}\\s*(?:${WEEKDAY},?\\s+)?(?:${MONTH}\\s+)?${DAY}\\b)*,?\\s+(${YEAR})\\b`,
  'gu',
)
const DAY_MONTH_YEAR = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH})\\s+(${YEAR})\\b`, 'gu')
// "May 2027", "September, October and November 2026", "September–November 2026".
const MONTH_LIST_YEAR = new RegExp(
  `\\b${MONTH}(?:\\s*${LIST_SEPARATOR}\\s*${MONTH})*\\s+(${YEAR})\\b`,
  'gu',
)
const MONTH_NAME = new RegExp(`\\b${MONTH}(?![\\p{L}])`, 'gu')
const ISO_DATE = /\b((?:19|20)\d{2})-(\d{2})-(\d{2})\b/gu
const US_NUMERIC_DATE = /\b(\d{1,2})\/(\d{1,2})\/((?:19|20)\d{2})\b/gu
const PAIR = new RegExp(`(?:(${MONTH})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gu')
const RANGE_WORD = /(?:\bto\b|\bthrough\b|\bthru\b|\buntil\b|\btill\b|[-–—])/u
// "Starting March 1, 2026", "opened in April 2025". Observation dates ("prices are from the
// June 11, 2026 menu", "checked October 23, 2026") say when something was seen, not when it ends.
const OPEN_START =
  /\b(?:starting|starts|beginning|begins|began|effective|as of|since|from(?: the)?|after|opens|opened|reopens|reopened|launch(?:es|ed)?|available|dated|checked|updated|published|posted|observed|verified|retrieved|accessed)\s+(?:(?:on|in)\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?$/iu
const OPEN_START_WINDOW = 40

export type GuestStatedDate = { iso: string; year: number; openStart: boolean }

function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCMonth() !== month - 1) return null
  return date.toISOString().slice(0, 10)
}

function monthNumber(token: string): number | null {
  return MONTHS[token.replace(/\.$/u, '')] ?? null
}

function opensAt(text: string, index: number): boolean {
  return OPEN_START.test(text.slice(Math.max(0, index - OPEN_START_WINDOW), index))
}

/**
 * Every calendar date the text writes with a year, whether each opens an open-ended period,
 * and whether any month name is written without a year.
 */
export function guestStatedDates(text: string): {
  dates: GuestStatedDate[]
  undatedMonth: boolean
} {
  const dates: GuestStatedDate[] = []
  const claimed: Array<[number, number]> = []
  const free = (start: number, end: number) =>
    claimed.every(([from, to]) => end <= from || start >= to)
  const push = (value: string | null, year: number, openStart: boolean) => {
    if (value) dates.push({ iso: value, year, openStart })
  }

  for (const match of text.matchAll(MONTH_DAY_SPAN)) {
    const start = match.index!
    const span = match[0]
    const year = Number(match[1])
    const body = span.slice(0, span.lastIndexOf(match[1]!))
    claimed.push([start, start + span.length])
    let month: number | null = null
    let last: string | null = null
    for (const pair of body.matchAll(PAIR)) {
      if (pair[1]) month = monthNumber(pair[1])
      if (month) last = iso(year, month, Number(pair[2])) ?? last
    }
    push(last, year, opensAt(text, start) && !RANGE_WORD.test(body))
  }
  for (const match of text.matchAll(DAY_MONTH_YEAR)) {
    const start = match.index!
    if (!free(start, start + match[0].length)) continue
    claimed.push([start, start + match[0].length])
    const month = monthNumber(match[2]!)
    if (month)
      push(iso(Number(match[3]), month, Number(match[1])), Number(match[3]), opensAt(text, start))
  }
  for (const match of text.matchAll(MONTH_LIST_YEAR)) {
    const start = match.index!
    if (!free(start, start + match[0].length)) continue
    claimed.push([start, start + match[0].length])
    const year = Number(match[1])
    const months = [...match[0].matchAll(MONTH_NAME)].map((name) => monthNumber(name[0]))
    const month = months.at(-1)
    if (!month) continue
    // A month names its last day: "through May 2027" ends on May 31.
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    push(iso(year, month, lastDay), year, opensAt(text, start) && months.length === 1)
  }
  for (const match of text.matchAll(ISO_DATE)) {
    const start = match.index!
    if (!free(start, start + match[0].length)) continue
    push(
      iso(Number(match[1]), Number(match[2]), Number(match[3])),
      Number(match[1]),
      opensAt(text, start),
    )
  }
  for (const match of text.matchAll(US_NUMERIC_DATE)) {
    const start = match.index!
    if (!free(start, start + match[0].length)) continue
    push(
      iso(Number(match[3]), Number(match[1]), Number(match[2])),
      Number(match[3]),
      opensAt(text, start),
    )
  }
  const undatedMonth = [...text.matchAll(MONTH_NAME)].some((match) =>
    free(match.index!, match.index! + match[0].length),
  )
  return { dates, undatedMonth }
}

/**
 * The latest date a record states, when every date it states has passed.
 * `currentDate` is the venue-local YYYY-MM-DD. Dates from before last year are history
 * ("opened in May 2019"), not schedule periods, and are ignored.
 */
export function guestStatedDatesPassed(
  entry: { title: string; content?: string | null },
  currentDate: string,
): string | null {
  const text = `${entry.title}\n${entry.content ?? ''}`
  const currentYear = Number(currentDate.slice(0, 4))
  if (!Number.isInteger(currentYear) || !/^\d{4}-\d{2}-\d{2}$/u.test(currentDate)) return null
  const stated = guestStatedDates(text)
  if (stated.undatedMonth) return null
  const dates = stated.dates.filter((date) => date.year >= currentYear - 1)
  if (dates.length === 0) return null
  if (dates.some((date) => date.openStart)) return null
  const latest = dates.reduce((max, date) => (date.iso > max ? date.iso : max), dates[0]!.iso)
  if (latest >= currentDate) return null
  // Any later year written anywhere ("returns in 2027") is a sign of a newer period.
  if (hasNearYearSign(text, Number(latest.slice(0, 4)) + 1)) return null
  return latest
}
