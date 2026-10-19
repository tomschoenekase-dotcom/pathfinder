// Dated-event classification shared by the visitor guide renderer and retrieval. The server only
// asserts that an event is over when its record gives no sign of a newer run. A record whose text
// dates something in this year or a near later one is shown in full with a neutral marker, and
// the model decides from the record's own dates and today's date. No sentence is parsed as "the
// event date", so a source-check date or a list of dates cannot flip the outcome; a year counts
// only when it is part of a date (a month, season or numeric date), not a footer or an address.

export const GUEST_DATED_TITLE_RULE_VERSION = 'guest-dated-title-v2'

export const PAST_EVENT_TITLE =
  /\b(event|festival|fest|season|celebration|special|nights?|holiday|weekend)s?\b/iu

const YEAR = /\b(?:19|20)\d{2}\b/gu
// "2025-26" or "2025/26": a season spanning both years.
const SEASON_SPAN = /\b((?:19|20)\d{2})\s*[-/–]\s*(\d{2})\b/gu
// A month or season word shortly before a year makes it a date ("October 23, 24 and 31, 2026").
const DATE_WORD =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|spring|summer|autumn|fall|winter|season)\b/iu
const SEASON_AFTER = /^\s*(?:season|spring|summer|autumn|fall|winter)\b/iu
// "30/10/2026", "10.30.2026" before the year; "2026-10-30" after it.
const NUMERIC_DATE_BEFORE = /\b\d{1,2}[/.]\d{1,2}[/.]$/u
const ISO_DATE_AFTER = /^-\d{2}-\d{2}\b/u
const DATE_WINDOW_CHARS = 40
// Years this far ahead are not plausible run dates.
const NEAR_FUTURE_YEARS = 5
// Shortly after New Year, last year's winter or holiday run may still be on.
const NEW_YEAR_GRACE_MONTHS = 3

export type GuestDatedEventStatus =
  /** No passed year in the title, or a non-event record with nothing newer dated. */
  | 'CURRENT'
  /** An event title whose years have all passed, with no dated sign of a newer run. */
  | 'PAST'
  /** The title year has passed but the record dates something this year or soon after. */
  | 'CHECK_DATES'

export const GUEST_DATED_TITLE_RULE =
  "A topic marked title_year_passed has an earlier year in its title than the current year. Decide from the dates in its own text and today's date whether it still applies, never from its title; if its text does not settle that, say you're not sure and who can check."

function titleYears(title: string): number[] {
  const years = [...title.matchAll(YEAR)].map((match) => Number(match[0]))
  for (const match of title.matchAll(SEASON_SPAN)) {
    years.push(Math.floor(Number(match[1]) / 100) * 100 + Number(match[2]))
  }
  return years
}

/** True when the text uses a year in [currentYear, currentYear + 5] as part of a date. */
function hasNearDatedYear(text: string, currentYear: number): boolean {
  for (const match of text.matchAll(YEAR)) {
    const year = Number(match[0])
    if (year < currentYear || year > currentYear + NEAR_FUTURE_YEARS) continue
    const index = match.index!
    // The words just before the year, cut at a sentence boundary.
    const before =
      text
        .slice(Math.max(0, index - DATE_WINDOW_CHARS), index)
        .split(/(?<!\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec))[.!?]\s+/iu)
        .at(-1) ?? ''
    const after = text.slice(index + match[0].length, index + match[0].length + 20)
    if (
      DATE_WORD.test(before) ||
      SEASON_AFTER.test(after) ||
      NUMERIC_DATE_BEFORE.test(before) ||
      ISO_DATE_AFTER.test(after)
    )
      return true
  }
  return false
}

function todayParts(today: number | string): { year: number; month: number | null } {
  if (typeof today === 'number') return { year: today, month: null }
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) || null }
}

export function classifyGuestDatedEvent(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): GuestDatedEventStatus {
  const { year: currentYear, month } = todayParts(today)
  const years = titleYears(entry.title)
  if (years.length === 0 || !years.every((year) => year < currentYear)) return 'CURRENT'
  // Any record with a passed title year whose text dates something soon gets the neutral
  // marker, whatever its title words or language.
  if (hasNearDatedYear(entry.content ?? '', currentYear)) return 'CHECK_DATES'
  if (!PAST_EVENT_TITLE.test(`${entry.title} ${entry.category}`)) return 'CURRENT'
  const lastYearRun =
    Math.max(...years) === currentYear - 1 && month !== null && month <= NEW_YEAR_GRACE_MONTHS
  return lastYearRun ? 'CHECK_DATES' : 'PAST'
}

/** Only records the server can call over: they are shown as a title in the past list. */
export function isPastDatedGuestEvent(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): boolean {
  return classifyGuestDatedEvent(entry, today) === 'PAST'
}

/** The latest passed title year, for the neutral marker on a CHECK_DATES topic. */
export function guestPassedTitleYear(title: string): string | null {
  const years = titleYears(title)
  return years.length ? String(Math.max(...years)) : null
}

/** For a one-line summary: the sentence that dates a near year, when there is one. */
export function guestDatedSummarySentence(text: string, today: number | string): string | null {
  const { year } = todayParts(today)
  return (
    text
      .split(/(?<=[.!?])\s+/u)
      .find((sentence) => hasNearDatedYear(sentence, year))
      ?.trim() ?? null
  )
}
