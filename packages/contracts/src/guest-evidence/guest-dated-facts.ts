// "that day pass" or "same day tickets" names a product, not an earlier date.
export const REFERRED_DATE =
  /\b(?:that|same) (?:date|day|night)\b(?![ -]?(?:pass|passes|ticket|tickets|admission|rate|rates|price|prices|pricing|parking|entry|trip|trips|camp|use|only)\b)/iu
// Words that say when or whether, not what. A follow-up made only of these keeps its subject.
export const GENERIC_FOLLOWUP_TOKENS = new Set([
  'date',
  'day',
  'night',
  'time',
  'times',
  'still',
  'then',
  'too',
  'also',
  'well',
  'go',
  'going',
  'visit',
  'come',
  'busy',
  'crowded',
  'late',
  'early',
])
export const DATE_WORD =
  /^(?:\d+|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)$/u
const DATE_MONTH =
  '(?:January|February|March|April|May|June|July|August|September|October|November|December)'
const EXPLICIT_DATE = new RegExp(
  `\\b${DATE_MONTH}\\b|\\b\\d{1,2}(?:st|nd|rd|th)\\b|\\b(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?|\\b\\d{4}-\\d{2}-\\d{2}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:today|tomorrow|yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b`,
  'iu',
)

// "those days" or "the latter of those days" points back at every date the visitor just listed.
export const REFERRED_DATES =
  /\b(?:the (?:latter|former|first|second) of (?:those|these|the two|both) (?:dates|days|nights)|the (?:latter|former) (?:date|day|night)|(?:those|these|both|either of those) (?:dates|days|nights))\b/iu
// Filler that would otherwise use up the lexical concept budget in a dated follow-up.
export const DATED_FOLLOWUP_FILLER =
  /\b(?:now|same|time|times|okay|ok|yes|yeah|actually|again|well|then|too|also|still|though|day|days|date|dates|night|nights)\b/giu
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
]

function dateTerms(year: number, month: number, day: number): string[] | null {
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null
  const name = MONTHS[month - 1]!
  return [
    `${name} ${day}, ${year}`,
    `${name} ${day} ${year}`,
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  ]
}

/** Two or three dates joined by "and" that share one stated year, for "those days" only. */
function listedPriorDates(previousQuery: string): string[] | null {
  const pattern = new RegExp(
    `\\b(${DATE_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`,
    'giu',
  )
  const matches = [...previousQuery.matchAll(pattern)]
  if (matches.length < 2 || matches.length > 3) return null
  const years = new Set(matches.map((m) => m[3] ?? m[4]).filter(Boolean))
  if (years.size !== 1) return null
  const year = Number([...years][0])
  // Only plain "and" lists: alternatives and ranges must never become a set of dates.
  for (let index = 1; index < matches.length; index++) {
    const previous = matches[index - 1]!
    const between = previousQuery.slice(previous.index! + previous[0].length, matches[index]!.index)
    if (
      !/^\s*(?:,\s*)?(?:and|&)?\s*(?:(?:on|for)\s+)?(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?$/iu.test(
        between,
      )
    )
      return null
  }
  const remaining = matches
    .reduce((text, m) => text.replace(m[0], ' '), previousQuery)
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/giu, '')
  if (
    EXPLICIT_DATE.test(remaining) ||
    new RegExp(
      `\\b${DATE_MONTH}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:or|through|until|between)\\b|\\bto\\s+\\d|[-–—]\\s*\\d`,
      'iu',
    ).test(remaining)
  )
    return null
  const terms: string[] = []
  for (const m of matches) {
    const month = m[1] ? MONTHS.indexOf(m[1].toLowerCase()) + 1 : Number(m[5])
    const next = dateTerms(year, month, Number(m[2] ?? m[6]))
    if (!next) return null
    terms.push(...next)
  }
  return [...new Set(terms)]
}

type CalendarDate = { year: number; month: number; day: number }
type GuestDateMention = { date: CalendarDate | null; text: string; index: number }
/** Exact calendar dates a visitor stated, for lexical retrieval only. */
export type GuestStatedDates = {
  kind: 'single' | 'list' | 'range'
  dates: CalendarDate[]
  terms: string[]
  /** Visitor text that named the dates, removed before subject concepts are built. */
  spans: string[]
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTH_ABBREVIATIONS = '(?:Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\.?'
const WEEKDAY_NAME = '(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)'
const STATED_DATE = new RegExp(
  `(?:\\b(${WEEKDAY_NAME}),?\\s+(?:the\\s+)?)?(?:\\b(${DATE_MONTH}|${MONTH_ABBREVIATIONS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!\\s*(?:[:.]\\d|am\\b|pm\\b|a\\.m|p\\.m|%|percent|minutes?|hours?|years?|months?|days?))(?:,?\\s+(20\\d{2})\\b)?|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b)`,
  'giu',
)
// Date forms this parser does not resolve. Their presence makes the stated dates unclear.
const UNRESOLVED_DATE_FORM = new RegExp(
  `\\b\\d{1,2}/\\d{1,2}\\b|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${DATE_MONTH}\\b|\\bthe\\s+\\d{1,2}(?:st|nd|rd|th)\\b|\\b(?:today|tonight|tomorrow|yesterday)\\b`,
  'iu',
)
// A date introduced by one of these words is a boundary or an exclusion, not a visit day.
const DATE_RELATION_BEFORE =
  /\b(?:after|before|following|prior to|until|till|through|thru|from|since|except|not|instead of|other than|than)\s*$/iu
const RANGE_DAYS_LIMIT = 14
const CHOICE_BETWEEN =
  /\b(?:decid\w*|choos\w*|chose|pick\w*|either|torn|which (?:day|date|one)|better day)\b/iu
export const FULL_DATE_IN_RECORD = new RegExp(
  `\\b(?:${MONTHS.join('|')}) \\d{1,2},? 20\\d{2}\\b|\\b20\\d{2}-\\d{2}-\\d{2}\\b`,
  'u',
)
// "October 11–November 1, 2026" or "October 3-31, 2026": a period rule (season, weekly
// pattern, closure) that may govern the visitor's date. Such records are never off-date.
export const DATE_PERIOD_IN_RECORD = new RegExp(
  `\\b(?:${MONTHS.join('|')}) \\d{1,2}\\s*(?:[–—-]|to|through|until)\\s*(?:(?:${MONTHS.join('|')}) )?\\d{1,2},? 20\\d{2}\\b`,
  'u',
)
const DAY_MS = 86_400_000

function calendarDate(year: number, month: number, day: number): CalendarDate | null {
  return dateTerms(year, month, day) ? { year, month, day } : null
}
function dateUtc(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}
function dateFromUtc(ms: number): CalendarDate {
  const value = new Date(ms)
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
}
function weekdayOf(date: CalendarDate): number {
  return new Date(dateUtc(date)).getUTCDay()
}
function monthNumber(name: string): number {
  const prefix = name.toLowerCase().replace('.', '').slice(0, 3)
  return MONTHS.findIndex((month) => month.startsWith(prefix)) + 1
}

/**
 * Resolves a month and day without a year only when the conversation clock makes it clear:
 * a stated weekday that matches exactly one nearby year, or the next occurrence within about
 * six months. The clock day is widened by one day so every venue time zone is covered.
 */
function inferYear(month: number, day: number, weekday: number | null, clock?: Date | null) {
  if (!clock || Number.isNaN(clock.getTime())) return null
  const today = Date.UTC(clock.getUTCFullYear(), clock.getUTCMonth(), clock.getUTCDate()) - DAY_MS
  const candidates = [-1, 0, 1]
    .map((offset) => calendarDate(clock.getUTCFullYear() + offset, month, day))
    .filter((date): date is CalendarDate => date !== null)
  const near =
    weekday === null
      ? candidates.filter((date) => dateUtc(date) >= today && dateUtc(date) <= today + 200 * DAY_MS)
      : candidates.filter(
          (date) =>
            weekdayOf(date) === weekday &&
            dateUtc(date) >= today - 60 * DAY_MS &&
            dateUtc(date) <= today + 366 * DAY_MS,
        )
  return near.length === 1 ? near[0]! : null
}

function statedDateMentions(text: string, clock?: Date | null): GuestDateMention[] {
  return [...text.matchAll(STATED_DATE)].map((match) => {
    const weekday = match[1] ? WEEKDAYS.indexOf(match[1].toLowerCase()) : null
    let date: CalendarDate | null
    if (match[5]) date = calendarDate(Number(match[5]), Number(match[6]), Number(match[7]))
    else {
      const month = monthNumber(match[2]!)
      const day = Number(match[3])
      date = match[4]
        ? calendarDate(Number(match[4]), month, day)
        : inferYear(month, day, weekday, clock)
    }
    // A stated weekday that disagrees with the date is a conflict, never a guess.
    if (date && weekday !== null && weekdayOf(date) !== weekday) date = null
    return { date, text: match[0], index: match.index! }
  })
}

function termsFor(dates: CalendarDate[]): string[] {
  return [...new Set(dates.flatMap((date) => dateTerms(date.year, date.month, date.day)!))]
}

/**
 * The one shared parser for exact dates a visitor stated in one message: a single date, a short
 * "and" list, or a bounded "between X and Y" interval (every day in it, never just the two ends).
 * Unresolvable years, conflicting weekdays, alternatives, open ranges and other date forms
 * return null so retrieval falls back to ordinary words.
 */
export function guestStatedDates(text: string, clock?: Date | null): GuestStatedDates | null {
  const mentions = statedDateMentions(text, clock)
  if (mentions.length === 0 || mentions.length > 3) return null
  let remaining = text
  for (const mention of mentions) remaining = remaining.replace(mention.text, ' ')
  if (UNRESOLVED_DATE_FORM.test(remaining) || /\b20\d{2}\b/u.test(remaining)) return null
  for (const mention of mentions) {
    if (DATE_RELATION_BEFORE.test(text.slice(Math.max(0, mention.index - 24), mention.index)))
      if (!/\bbetween\s*$/iu.test(text.slice(0, mention.index))) return null
  }
  const glue = (index: number) =>
    text.slice(
      mentions[index - 1]!.index + mentions[index - 1]!.text.length,
      mentions[index]!.index,
    )
  const betweenBefore = (index: number) =>
    /\bbetween\s+(?:(?:on|the)\s+)?$/iu.test(text.slice(0, mentions[index]!.index))
  if (mentions.length === 2 && betweenBefore(0) && /^\s*,?\s*and\s+(?:on\s+)?$/iu.test(glue(1))) {
    let [start, end] = [mentions[0]!.date, mentions[1]!.date]
    const parts = (mention: GuestDateMention) => ({
      month: monthNumber(
        mention.text.match(new RegExp(`${DATE_MONTH}|${MONTH_ABBREVIATIONS}`, 'iu'))?.[0] ?? '',
      ),
      day: Number(mention.text.replace(/20\d{2}/u, '').match(/\d{1,2}/u)?.[0]),
      weekday: mention.text.match(new RegExp(WEEKDAY_NAME, 'iu'))?.[0]?.toLowerCase() ?? null,
    })
    // "between November 7 and November 9, 2026": one trailing year covers both ends.
    if (
      !start &&
      end &&
      /\b20\d{2}\b/u.test(mentions[1]!.text) &&
      !/\b20\d{2}\b/u.test(mentions[0]!.text)
    ) {
      const { month, day, weekday } = parts(mentions[0]!)
      for (const year of [end.year, end.year - 1]) {
        const candidate = month ? calendarDate(year, month, day) : null
        if (candidate && dateUtc(candidate) <= dateUtc(end)) {
          start = weekday && WEEKDAYS[weekdayOf(candidate)] !== weekday ? null : candidate
          break
        }
      }
    }
    // "between December 30 and January 2": an end without a year rolls into the next year.
    if (start && !end && !/\b20\d{2}\b/u.test(mentions[1]!.text)) {
      const { month, day, weekday } = parts(mentions[1]!)
      for (const year of [start.year, start.year + 1]) {
        const candidate = month ? calendarDate(year, month, day) : null
        if (candidate && dateUtc(candidate) >= dateUtc(start)) {
          end = weekday && WEEKDAYS[weekdayOf(candidate)] !== weekday ? null : candidate
          break
        }
      }
    }
    if (start && end && !/\b20\d{2}\b/u.test(mentions[1]!.text) && dateUtc(end) < dateUtc(start)) {
      const rolled = calendarDate(end.year + 1, end.month, end.day)
      end = rolled && dateUtc(rolled) - dateUtc(start) < RANGE_DAYS_LIMIT * DAY_MS ? rolled : end
    }
    if (!start || !end) return null
    const span = (dateUtc(end) - dateUtc(start)) / DAY_MS
    if (span < 1 || span >= RANGE_DAYS_LIMIT) return null
    // "Deciding between Sunday and Saturday" names two candidate days, not an interval.
    if (CHOICE_BETWEEN.test(text)) {
      const dates = [start, end]
      return { kind: 'list', dates, terms: termsFor(dates), spans: mentions.map((m) => m.text) }
    }
    const dates = Array.from({ length: span + 1 }, (_, offset) =>
      dateFromUtc(dateUtc(start!) + offset * DAY_MS),
    )
    return { kind: 'range', dates, terms: termsFor(dates), spans: mentions.map((m) => m.text) }
  }
  if (mentions.some((mention) => !mention.date)) return null
  if (/\bbetween\b|\bor\b|[-–—]\s*\d|\bto\s+\d/iu.test(remaining)) return null
  for (let index = 1; index < mentions.length; index++) {
    if (!/^\s*(?:,\s*)?(?:and|&)?\s*(?:(?:on|for)\s+)?$/iu.test(glue(index))) return null
  }
  const dates = mentions.map((mention) => mention.date!)
  return {
    kind: dates.length === 1 ? 'single' : 'list',
    dates,
    terms: termsFor(dates),
    spans: mentions.map((mention) => mention.text),
  }
}

// One step from exactly one earlier visitor date: "the next day", "the day after", "the
// following Sunday". Anything longer or vaguer ("next week", "the day after the show") fails closed.
const DATE_OFFSET = new RegExp(
  `\\b(?:the\\s+)?(?:next|following)\\s+day\\b|\\bthe\\s+day\\s+after\\b(?=\\s*(?:[?.!,;]|$|too\\b|then\\b|as well\\b|instead\\b))|\\bthe\\s+(?:next|following)\\s+(${WEEKDAY_NAME})\\b`,
  'iu',
)

/** A one-step offset from the single date the visitor stated in the previous message. */
export function guestOffsetDateConcept(
  query: string,
  previousQuery?: string | null,
  clock?: Date | null,
): GuestStatedDates | null {
  if (!previousQuery) return null
  const offsets = [...query.matchAll(new RegExp(DATE_OFFSET.source, 'giu'))]
  if (offsets.length !== 1) return null
  const rest = query.replace(offsets[0]![0], ' ')
  if (statedDateMentions(rest, clock).length || UNRESOLVED_DATE_FORM.test(rest)) return null
  if (/\b(?:week|weeks|month|months|year|years|before|previous|earlier)\b/iu.test(rest)) return null
  if (PRIOR_DATE_CORRECTION.test(previousQuery)) return null
  const prior = guestStatedDates(previousQuery, clock)
  if (!prior || prior.kind !== 'single') return null
  const anchor = dateUtc(prior.dates[0]!)
  const weekdayName = offsets[0]![1]
  let next: number
  if (weekdayName) {
    const wanted = WEEKDAYS.indexOf(weekdayName.toLowerCase())
    const ahead = (wanted - weekdayOf(prior.dates[0]!) + 7) % 7 || 7
    next = anchor + ahead * DAY_MS
  } else next = anchor + DAY_MS
  const date = dateFromUtc(next)
  return { kind: 'single', dates: [date], terms: termsFor([date]), spans: [offsets[0]![0]] }
}

const PRIOR_DATE_CORRECTION =
  /\b(?:not|never|instead|actually|correction|corrected|changed|cancelled|canceled|forget|ignore|previously|last|ago|was|were)\b|\bno longer\b|n['’]t\b/iu

/** Explicit dates in the immediately preceding visitor query, for lexical retrieval only:
 * one date for "that day", or a short "and" list or bounded "between" interval for "those
 * days". No assistant text or older conversation search is accepted. Ambiguity fails closed.
 */
export function guestPriorDateConcept(
  query: string,
  previousQuery?: string | null,
  clock?: Date | null,
): string[] | null {
  if (!previousQuery || EXPLICIT_DATE.test(query)) return null
  const plural = REFERRED_DATES.test(query)
  if (!plural && !REFERRED_DATE.test(query)) return null
  // An offset or rejection changes the referent; never reuse its exact calendar date.
  if (
    /\b(?:not|never|instead|different|another|after|before|following|next|previous|later|earlier|week|month|year)\b|n['’]t\b/iu.test(
      query,
    )
  )
    return null
  if (PRIOR_DATE_CORRECTION.test(previousQuery)) return null
  if (plural) {
    const listed = listedPriorDates(previousQuery)
    if (listed) return listed
    const interval = guestStatedDates(previousQuery, clock)
    return interval && interval.kind === 'range' ? interval.terms : null
  }
  const pattern = new RegExp(
    `\\b(${DATE_MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b|\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b`,
    'giu',
  )
  const dates = [...previousQuery.matchAll(pattern)]
  if (dates.length !== 1) {
    // No stated year: accept one date only when the conversation clock makes its year clear.
    const stated = dates.length === 0 ? guestStatedDates(previousQuery, clock) : null
    return stated && stated.kind === 'single' ? stated.terms : null
  }
  const match = dates[0]!
  const month = match[1] ? MONTHS.indexOf(match[1].toLowerCase()) + 1 : Number(match[5])
  const terms = dateTerms(Number(match[3] ?? match[4]), month, Number(match[2] ?? match[6]))
  if (!terms) return null
  const remaining = previousQuery
    .replace(match[0], '')
    .replace(/\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/giu, '')
  // Partial dates, ranges and alternatives must never select one date silently.
  if (
    EXPLICIT_DATE.test(remaining) ||
    new RegExp(
      `\\b${DATE_MONTH}\\b|\\b\\d{1,2}/\\d{1,2}|\\b(?:or|through|until|between)\\b|\\bto\\s+\\d|[-–—]\\s*\\d`,
      'iu',
    ).test(remaining)
  )
    return null
  return terms
}
