import { describe, expect, it } from 'vitest'

import {
  GUEST_DATED_TITLE_RULE,
  classifyGuestDatedEvent,
  classifyGuestDatedEventWithReason,
  guestDatedSummarySentence,
} from './guest-event-dates'
import { buildGuestVenueDirectoryPrompt, type GuestVenueDirectory } from './guest-venue-directory'

const today = '2026-10-19'
const event = (title: string, content: string, category = 'Events') => ({
  title,
  category,
  content,
})
const status = (title: string, content: string, when = today, category = 'Events') =>
  classifyGuestDatedEvent(event(title, content, category), when)

describe('dated-title classification', () => {
  it('never calls an event over when its text names this year or soon after, in any form', () => {
    for (const content of [
      'Returns October 23, 24, 30 and 31, 2026, from 6 pm to 9 pm.',
      'Returns Fridays and Saturdays: October 2, 3, 9, 10, 16, 17, 23, 24, 30 and 31, 2026.',
      'Weekends in October (2, 3, 9, 10, 16, 17, 23, 24, 30, 31), 2026.',
      'The festival ran October 30 and 31, 2025. Checked October 18, 2026 against the official site.',
      'Back for Halloween 2026.',
      'Returns Christmas 2026.',
      'The festival returns in 2026, dates to be announced.',
      'Retour les 23 et 24 octobre 2026.',
      'Wieder vom 27. November bis 23. Dezember 2026.',
      'Vuelve del 3 al 5 de octubre de 2026.',
      '2026年10月23日',
      'Returns 2026/10/23.',
      'Next festival: spring 2027 (dates TBA).',
      'Opens 1.11.2026.',
      'Dates: 23.10.2026 and 24.10.2026.',
      'Oct. 23-24, 2026.',
      'Wieder ab 10-2026.',
      'There is no 2026 run planned yet.',
    ])
      expect(status('Lantern Festival 2025', content)).toBe('CHECK_DATES')
  })

  it('calls an event over only when nothing in its text points at a newer run', () => {
    for (const content of [
      'The festival ran October 30 and 31, 2025.',
      'Held April 5 to 7, 2024. (c) 2026 Example Park.',
      'Held April 5 to 7, 2024. © 2026 Example Park.',
      'Held April 5 to 7, 2024. Call 555-2027.',
      'Held April 5 to 7, 2024. Meet at 2030 Main Street.',
      'Held April 5 to 7, 2024. Ticket No. 2026 is the last one issued.',
      'Held April 5 to 7, 2024. Next run in 2040.',
      '',
    ])
      expect(status('Spring Fest 2024', content)).toBe('PAST')
    // Deferred, same as the released baseline: a year-less recurring body cannot be told apart.
    expect(status('Halloween Nights 2025', 'Fridays and Saturdays in October.')).toBe('PAST')
  })

  it('handles season spans and the months after New Year without asserting either way', () => {
    // A span ending this year may be running (January) or over (October): marker, never "over".
    expect(status('Ski Season 2025-26', 'Runs through February 28.', '2026-01-10')).toBe(
      'CHECK_DATES',
    )
    expect(status('Ski Season 2025-26', 'Ran December 2025 to April 2026.', '2026-10-19')).toBe(
      'CHECK_DATES',
    )
    expect(status('Winter Season 2026-27', 'Opens December 12.', '2026-10-19')).toBe('CURRENT')
    expect(status('Winter Season 2024-25', 'Runs through February 28.', '2026-10-19')).toBe('PAST')
    expect(status('Holiday Lights 2025', 'Nov 21 to Jan 4.', '2026-01-02')).toBe('CHECK_DATES')
    expect(status('Holiday Lights 2025', 'Nov 21 to Jan 4.', '2026-10-19')).toBe('PAST')
    expect(status('Holiday Lights 2024', 'Nov 21 to Jan 4.', '2026-01-02')).toBe('PAST')
    expect(
      classifyGuestDatedEventWithReason(
        event('Holiday Lights 2025', 'Nov 21 to Jan 4.'),
        '2026-01-02',
      ).reason,
    ).toBe('NEW_YEAR_GRACE')
  })

  it('marks any passed-year title with a near-year body, whatever its title words', () => {
    expect(status('Weihnachtsmarkt 2025', 'Wieder geöffnet ab 27/11/2026.', today, 'Markt')).toBe(
      'CHECK_DATES',
    )
    expect(status('Menu 2025', 'Updated May 2026.', today, 'Food')).toBe('CHECK_DATES')
    expect(status('Annual report 2024', 'Visitor numbers grew.', today, 'About')).toBe('CURRENT')
    expect(status('Lantern Festival 2026', 'Returns October 30.')).toBe('CURRENT')
  })

  it('summarizes a marked topic with its dated sentence, abbreviation-safe and capped', () => {
    expect(
      guestDatedSummarySentence(
        'The 2025 festival ran Oct. 30 and 31. Returns Oct. 23, 2026.',
        today,
      ),
    ).toBe('Returns Oct. 23, 2026.')
    expect(guestDatedSummarySentence('Ended.\nReturns\n  October 23, 2026.', today)).toBe(
      'Returns October 23, 2026.',
    )
    expect(guestDatedSummarySentence(`Returns October 23, 2026. ${'x'.repeat(10)}`, today)).toBe(
      'Returns October 23, 2026.',
    )
    expect(
      guestDatedSummarySentence(`Returns ${'very '.repeat(60)}October 23, 2026.`, today)!.length,
    ).toBe(160)
    expect(guestDatedSummarySentence('It ran in 2025.', today)).toBeNull()
  })

  it('puts the rule in the trusted directory header and summarizes with the dated sentence', () => {
    const directory = {
      knowledge: [
        {
          id: 'k1',
          title: 'Lantern Festival 2025',
          category: 'Events',
          content:
            'The 2025 festival ran October 30 and 31. Returns October 23, 24, 30 and 31, 2026.',
          sourceUrl: null,
        },
      ],
      places: [],
      incomplete: false,
    } as unknown as GuestVenueDirectory
    const prompt = buildGuestVenueDirectoryPrompt(directory, { currentDate: today })
    const open = prompt.indexOf('<untrusted_venue_data>')
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeGreaterThan(-1)
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeLessThan(open)
    expect(prompt.slice(open)).not.toContain(GUEST_DATED_TITLE_RULE)
    expect(prompt).toContain(
      'Lantern Festival 2025 (title_year_passed="2025"): Returns October 23, 24, 30 and 31, 2026.',
    )
  })
})
