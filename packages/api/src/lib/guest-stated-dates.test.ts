import { describe, expect, it } from 'vitest'
import {
  GUEST_STATED_DATES_RULE,
  guestStatedDates,
  guestStatedDatesEnabled,
  guestStatedDatesPassed,
} from './guest-stated-dates'
import { classifyGuestDatedEvent } from './guest-event-dates'

const topic = (content: string, title = 'Fictional topic') => ({
  title,
  category: 'Events',
  content,
})

describe('guest stated dates', () => {
  it('reads the end of real authored spans, day lists, month lists and cross-year ranges', () => {
    const cases: Array<[string, string]> = [
      ['Hours: daily, 10 am to 4 pm, September 8, 2026 to May 28, 2027.', '2027-05-28'],
      ['Thursday to Sunday, October 1 to October 31, 2026, 6 pm to 10 pm.', '2026-10-31'],
      ['On event days, October 9–11, 16–18 and 23–25, 2026, visits end at 4pm.', '2026-10-25'],
      [
        'Season: Fieldfest operating weekends in September, October and November 2026.',
        '2026-11-30',
      ],
      [
        'Hours: 8pm Thursday, December 31, 2026–midnight as Friday, January 1, 2027 begins.',
        '2027-01-01',
      ],
      ['Hours: 1pm Saturday and Sunday, April 4–5, 2026.', '2026-04-05'],
      ['Valid through 2026-10-31.', '2026-10-31'],
      ['Ends 10/31/2026 at close.', '2026-10-31'],
      ['Held 24 October 2026 in the barn.', '2026-10-24'],
    ]
    for (const [text, latest] of cases) {
      const dates = guestStatedDates(text).dates.map((date) => date.iso)
      expect(dates.sort().at(-1), text).toBe(latest)
    }
  })

  it('marks a record only after every date it states has passed', () => {
    const hours = topic(
      'Moonbeam Zoo is open daily, 10 a.m. to 4 p.m., September 8, 2026 to May 28, 2027.',
    )
    expect(guestStatedDatesPassed(hours, '2026-11-15')).toBeNull()
    expect(guestStatedDatesPassed(hours, '2027-05-28')).toBeNull()
    expect(guestStatedDatesPassed(hours, '2027-05-29')).toBe('2027-05-28')
    const lanterns = topic('Pumpkin Glow Nights runs Thursday to Sunday, October 1 to 31, 2026.')
    expect(guestStatedDatesPassed(lanterns, '2026-10-31')).toBeNull()
    expect(guestStatedDatesPassed(lanterns, '2026-11-01')).toBe('2026-10-31')
  })

  it('covers the authored records the title-year rule cannot see', () => {
    const lanterns = topic(
      'Hours: Thursday to Sunday, October 1 to October 31, 2026, 6 pm to 10 pm.',
      "Pumpkin Glow Nights",
    )
    // No year in the title, so the existing server rule calls it current forever.
    expect(classifyGuestDatedEvent(lanterns, '2027-03-01')).toBe('CURRENT')
    expect(guestStatedDatesPassed(lanterns, '2027-03-01')).toBe('2026-10-31')
  })

  it('never marks a record with an undated or yearly schedule', () => {
    // Recurring garden hours plus one dated event: the hours still apply next June.
    const garden = topic(
      'Lantern Gardens opens May–October. In June–August, hours are Tuesday–Sunday 9am–5pm. On Glow Garden event days, October 9–11, 2026, daytime visits end at 4pm.',
    )
    expect(guestStatedDatesPassed(garden, '2027-06-15')).toBeNull()
    // Remaining dates written without a year are still ahead.
    const program = topic(
      'The October 17, 2026 date has passed; remaining announced dates are October 24, 30 and 31, noon to 3 p.m.',
    )
    expect(guestStatedDatesPassed(program, '2026-10-25')).toBeNull()
    const winter = topic(
      'Open daily 10 a.m. to 6 p.m. in October 2026. November–March hours are daily 11 a.m. to 4 p.m.',
    )
    expect(guestStatedDatesPassed(winter, '2026-11-15')).toBeNull()
  })

  it('treats start and observation dates as open-ended', () => {
    for (const text of [
      'Starting March 1, 2026, parking is $10 per car.',
      'The gift shop opened in April 2025 and sells local crafts.',
      'The following menu prices are from the June 11, 2026 menu; confirm current counter prices.',
      'The festival schedule was checked October 18, 2026 against the official site.',
      'Effective January 1, 2026, strollers are not allowed on the boardwalk.',
    ])
      expect(guestStatedDatesPassed(topic(text), '2026-11-15'), text).toBeNull()
    // A start inside a range still has an end.
    expect(
      guestStatedDatesPassed(topic('Open from May 23 to September 27, 2026.'), '2026-10-25'),
    ).toBe('2026-09-27')
  })

  it('holds back when a later year is named or the dates are only history', () => {
    expect(
      guestStatedDatesPassed(
        topic('Held October 3, 2026. A 2027 date will be announced.'),
        '2026-11-01',
      ),
    ).toBeNull()
    expect(
      guestStatedDatesPassed(topic('Founded March 3, 1923 by sailors.'), '2026-11-01'),
    ).toBeNull()
    expect(
      guestStatedDatesPassed(topic('Call 555-2027 about the October 3, 2026 tour.'), '2026-11-01'),
    ).toBe('2026-10-03')
  })

  it('does not read lower-case "may" or bad input as dates', () => {
    expect(guestStatedDates('Guests may 3 bags each in 2026.').dates).toEqual([])
    expect(guestStatedDates('February 30, 2026 is not a date.').dates).toEqual([])
    expect(guestStatedDatesPassed(topic('Held October 3, 2026.'), 'tomorrow')).toBeNull()
    expect(guestStatedDatesPassed({ title: 'Plain', content: null }, '2026-11-01')).toBeNull()
  })

  it('is off unless GUEST_CHAT_STATED_DATES is on, and its rule never hides a record', () => {
    expect(guestStatedDatesEnabled({})).toBe(false)
    expect(guestStatedDatesEnabled({ GUEST_CHAT_STATED_DATES: 'true' })).toBe(false)
    expect(guestStatedDatesEnabled({ GUEST_CHAT_STATED_DATES: ' ON ' })).toBe(true)
    expect(GUEST_STATED_DATES_RULE).toMatch(/Details it gives without any date are not affected/u)
  })
})
