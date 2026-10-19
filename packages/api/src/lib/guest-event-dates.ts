// Dated-event classification shared by the visitor guide renderer, retrieval and the authoring
// checks. The server only asserts that an event is over when its record gives no sign of a newer
// run. A record whose text names this year or a near later one is shown in full with a neutral marker,
// and the model decides from the record's own dates and today's date. No sentence in the body is
// parsed as "the event date", so a source-check date or a list of dates cannot flip the outcome.

export const PAST_EVENT_TITLE =
  /\b(event|festival|fest|season|celebration|special|nights?|holiday|weekend)s?\b/iu

const YEAR = /\b(?:19|20)\d{2}\b/gu
// Years this far ahead are not plausible run dates (street numbers, phone fragments).
const NEAR_FUTURE_YEARS = 5

export type GuestDatedEventStatus =
  /** No past year in an event title: an ordinary record. */
  | 'CURRENT'
  /** Every title year has passed and the text gives no sign of a newer run. */
  | 'PAST'
  /** The title year has passed but the text names this year or a near later one. */
  | 'CHECK_DATES'

export const GUEST_DATED_TITLE_RULE =
  "A topic marked title_year_passed has an earlier year in its title than the current year. Decide from the dates in its own text and today's date whether it still applies, never from its title; if its text does not settle that, say you're not sure and who can check."

function currentYearOf(today: number | string): number {
  return typeof today === 'number' ? today : Number(today.slice(0, 4))
}

export function classifyGuestDatedEvent(
  entry: { title: string; category: string; content?: string | null },
  today: number | string,
): GuestDatedEventStatus {
  const currentYear = currentYearOf(today)
  const titleYears = [...entry.title.matchAll(YEAR)].map((match) => Number(match[0]))
  if (
    titleYears.length === 0 ||
    !titleYears.every((year) => year < currentYear) ||
    !PAST_EVENT_TITLE.test(`${entry.title} ${entry.category}`)
  )
    return 'CURRENT'
  const content = entry.content ?? ''
  const nearYear = [...content.matchAll(YEAR)].some((match) => {
    const year = Number(match[0])
    return year >= currentYear && year <= currentYear + NEAR_FUTURE_YEARS
  })
  return nearYear ? 'CHECK_DATES' : 'PAST'
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
  const years = [...title.matchAll(YEAR)].map((match) => Number(match[0]))
  return years.length ? String(Math.max(...years)) : null
}
