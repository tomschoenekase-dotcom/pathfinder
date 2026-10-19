// Dated-event classification shared by the visitor guide renderer, retrieval and the authoring
// check. The two possible errors are not equal: calling a running event over hides its text and
// asserts something false, while marking an ended one only asks the model to read its dates. So
// the server calls an event over only when its text gives no sign of a newer run, and treats any
// near-future year as such a sign unless it is plainly not a date (a copyright line, a phone
// number, a ticket or street number). Nothing parses "the event date", so a source-check date, a
// long list of days, a holiday name or another language cannot flip the outcome.

export const GUEST_DATED_TITLE_RULE_VERSION = 'guest-dated-title-v3'

export const PAST_EVENT_TITLE =
  /\b(event|festival|fest|season|celebration|special|nights?|holiday|weekend)s?\b/iu

const YEAR = /\b(?:19|20)\d{2}\b/gu
// "2025-26" or "2025/26": a season spanning both years ("2025-2026" is read as two years).
const SEASON_SPAN = /\b((?:19|20)\d{2})\s*[-/–]\s*(\d{2})\b/gu
// A year that is plainly not a date: copyright, a ticket or reference number, a phone or code
// fragment ("555-2027"), or a street number ("2030 Main Street").
const NOT_A_DATE_BEFORE = /(?:\(c\)|©|copyright|\bno\.|#|\d{3,}-)\s*$/iu
const NOT_A_DATE_AFTER =
  /^\s+\p{Lu}[\p{L}'-]*(?:\s+\p{Lu}[\p{L}'-]*)?\s+(?:st|street|ave|avenue|rd|road|blvd|boulevard|lane|ln|way|drive|dr)\b/iu
// Years this far ahead are not plausible run dates.
const NEAR_FUTURE_YEARS = 5
// Shortly after New Year, last year's winter or holiday run may still be on.
const NEW_YEAR_GRACE_MONTHS = 3
const SUMMARY_CHARS = 160
// Split after a sentence end, keeping its punctuation, but not after a month abbreviation
// ("Oct. 23") or "No."; a blank line also ends a sentence, a single line break does not.
const SENTENCE_END =
  /(?<=[.!?])(?<!\b(?:jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|no)\.)\s+|\n\s*\n/iu

export type GuestDatedEventStatus =
  /** No passed year in the title, or a non-event record with nothing newer dated. */
  | 'CURRENT'
  /** An event title whose years have all passed, with no sign of a newer run. */
  | 'PAST'
  /** The title year has passed (or a season ends this year) and the record may still apply. */
  | 'CHECK_DATES'

/** Why a record was marked; the authoring check acts only on NEAR_YEAR. */
export type GuestDatedEventReason = 'NEAR_YEAR' | 'SEASON_ENDS_THIS_YEAR' | 'NEW_YEAR_GRACE' | null

export const GUEST_DATED_TITLE_RULE =
  "A topic marked title_year_passed has an earlier year in its title than the current year. Decide from the dates in its own text and today's date whether it still applies, never from its title; if its text does not settle that, say you're not sure and who can check."

function titleYearsOf(title: string): { years: number[]; spanEnds: number[] } {
  const years = [...title.matchAll(YEAR)].map((match) => Number(match[0]))
  const spanEnds: number[] = []
  for (const match of title.matchAll(SEASON_SPAN)) {
    const start = Number(match[1])
    let end = Math.floor(start / 100) * 100 + Number(match[2])
    if (end < start) end += 100
    spanEnds.push(end)
  }
  return { years: [...years, ...spanEnds], spanEnds }
}

/** True when the text names a year in [currentYear, currentYear + 5] that could be a date. */
export function hasNearYearSign(text: string, currentYear: number): boolean {
  for (const match of text.matchAll(YEAR)) {
    const year = Number(match[0])
    if (year < currentYear || year > currentYear + NEAR_FUTURE_YEARS) continue
    const index = match.index!
    const before = text.slice(Math.max(0, index - 12), index)
    const after = text.slice(index + match[0].length, index + match[0].length + 40)
    if (NOT_A_DATE_BEFORE.test(before) || NOT_A_DATE_AFTER.test(after)) continue
    return true
  }
  return false
}

function todayParts(today: number | string): { year: number; month: number | null } {
  if (typeof today === 'number') return { year: today, month: null }
  return { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) || null }
}

export function classifyGuestDatedEventWithReason(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): { status: GuestDatedEventStatus; reason: GuestDatedEventReason } {
  const { year: currentYear, month } = todayParts(today)
  const { years, spanEnds } = titleYearsOf(entry.title)
  if (years.length === 0) return { status: 'CURRENT', reason: null }
  // A season span ending this year ("Ski Season 2025-26" in 2026) may be running or over.
  if (spanEnds.includes(currentYear) && Math.min(...years) < currentYear)
    return { status: 'CHECK_DATES', reason: 'SEASON_ENDS_THIS_YEAR' }
  if (!years.every((year) => year < currentYear)) return { status: 'CURRENT', reason: null }
  // Any record with a passed title year whose text points at this year or soon after gets the
  // neutral marker, whatever its title words or language.
  if (hasNearYearSign(entry.content ?? '', currentYear))
    return { status: 'CHECK_DATES', reason: 'NEAR_YEAR' }
  if (!PAST_EVENT_TITLE.test(`${entry.title} ${entry.category}`))
    return { status: 'CURRENT', reason: null }
  if (Math.max(...years) === currentYear - 1 && month !== null && month <= NEW_YEAR_GRACE_MONTHS)
    return { status: 'CHECK_DATES', reason: 'NEW_YEAR_GRACE' }
  return { status: 'PAST', reason: null }
}

export function classifyGuestDatedEvent(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): GuestDatedEventStatus {
  return classifyGuestDatedEventWithReason(entry, today).status
}

/** Only records the server can call over: they are shown as a title in the past list. */
export function isPastDatedGuestEvent(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): boolean {
  return classifyGuestDatedEvent(entry, today) === 'PAST'
}

/** The earliest passed title year, for the neutral marker on a CHECK_DATES topic. */
export function guestPassedTitleYear(title: string): string | null {
  const { years } = titleYearsOf(title)
  return years.length ? String(Math.min(...years)) : null
}

/** For a one-line summary: the first sentence that names a near year, normalized and capped. */
export function guestDatedSummarySentence(text: string, today: number | string): string | null {
  const { year } = todayParts(today)
  const sentence = text
    .split(SENTENCE_END)
    .map((part) => part.replace(/\s+/gu, ' ').trim())
    .find((part) => part && hasNearYearSign(part, year))
  if (!sentence) return null
  return sentence.length > SUMMARY_CHARS
    ? `${sentence.slice(0, SUMMARY_CHARS - 1).trimEnd()}…`
    : sentence
}
