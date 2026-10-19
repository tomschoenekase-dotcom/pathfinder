import { describe, expect, it } from 'vitest'

import { GUEST_DATED_TITLE_RULE, classifyGuestDatedEvent } from './guest-event-dates'
import { buildGuestVenueDirectoryPrompt, type GuestVenueDirectory } from './guest-venue-directory'

const event = (title: string, content: string, category = 'Events') => ({
  title,
  category,
  content,
})

describe('dated-title classification (REVIEW-PRODUCT-04 probes)', () => {
  it('reads a season span in the title as covering both years', () => {
    expect(
      classifyGuestDatedEvent(
        event('Winter Season 2025-26', 'Runs through February 28.'),
        '2026-01-10',
      ),
    ).toBe('CURRENT')
    expect(
      classifyGuestDatedEvent(
        event('Winter Season 2025/26', 'Runs through February 28.'),
        '2026-01-10',
      ),
    ).toBe('CURRENT')
    expect(
      classifyGuestDatedEvent(
        event('Winter Season 2024-25', 'Runs through February 28.'),
        '2026-10-18',
      ),
    ).toBe('PAST')
  })

  it("does not call last year's event over in the first months after New Year", () => {
    expect(
      classifyGuestDatedEvent(event('Holiday Lights 2025', 'Nov 21 to Jan 4.'), '2026-01-02'),
    ).toBe('CHECK_DATES')
    expect(
      classifyGuestDatedEvent(event('Holiday Lights 2025', 'Nov 21 to Jan 4.'), '2026-10-18'),
    ).toBe('PAST')
    expect(
      classifyGuestDatedEvent(event('Holiday Lights 2024', 'Nov 21 to Jan 4.'), '2026-01-02'),
    ).toBe('PAST')
  })

  it('counts a near year only when the text uses it as a date', () => {
    for (const content of [
      '(c) 2026 Example Park.',
      'Refunds processed in 2026.',
      'Call 555-2027.',
      'At 2030 Main Street.',
      'Archived page, last edited 2026 by staff.',
    ])
      expect(
        classifyGuestDatedEvent(
          event('Spring Fest 2024', `Held April 5 to 7, 2024. ${content}`),
          '2026-10-18',
        ),
      ).toBe('PAST')
    for (const content of [
      'Returns October 23, 24, 30 and 31, 2026.',
      'Checked October 18, 2026 against the official site.',
      'Next festival: spring 2027 (dates TBA).',
      'Next run 2026-11-02.',
      'Dates: 30/10/2026.',
      'Back for the 2027 season.',
    ])
      expect(classifyGuestDatedEvent(event('Spring Fest 2024', content), '2026-10-18')).toBe(
        'CHECK_DATES',
      )
  })

  it('marks a passed-year title with a dated body whatever its title words or language', () => {
    expect(
      classifyGuestDatedEvent(
        event('Weihnachtsmarkt 2025', 'Wieder geöffnet ab 27/11/2026.', 'Markt'),
        '2026-10-18',
      ),
    ).toBe('CHECK_DATES')
    expect(
      classifyGuestDatedEvent(
        event('Lantern Walk 2025', 'Returns October 30, 2026.', 'Seasonal'),
        '2026-10-18',
      ),
    ).toBe('CHECK_DATES')
    // Without a dated body, a non-event record keeps the baseline: shown as an ordinary topic.
    expect(
      classifyGuestDatedEvent(
        event('Annual report 2024', 'Visitor numbers grew.', 'About'),
        '2026-10-18',
      ),
    ).toBe('CURRENT')
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
    const prompt = buildGuestVenueDirectoryPrompt(directory, { currentDate: '2026-10-18' })
    const open = prompt.indexOf('<untrusted_venue_data>')
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeGreaterThan(-1)
    expect(prompt.indexOf(GUEST_DATED_TITLE_RULE)).toBeLessThan(open)
    expect(prompt.slice(open)).not.toContain(GUEST_DATED_TITLE_RULE)
    expect(prompt).toContain(
      'Lantern Festival 2025 (title_year_passed="2025"): Returns October 23, 24, 30 and 31, 2026.',
    )
  })
})
