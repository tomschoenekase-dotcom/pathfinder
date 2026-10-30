import { describe, expect, it } from 'vitest'

import {
  guestTodayStatusCue,
  guestTodayStatusQuestion,
  parseVenueSchedule,
} from './guest-today-status'

// All venues below are fictional.
const brackenmoor = {
  title: 'Opening times',
  category: 'hours',
  content:
    'Summer season (1 March to 31 October): open every day, 9:30 to 17:30, last entry 16:30. Winter season (1 November to 28 February): open Wednesday to Sunday, 10:00 to 16:00, last entry 15:00. The park is closed on Mondays and Tuesdays in the winter season, except from 21 to 31 December 2026, when we open every day 10:00 to 16:00 apart from Christmas Day. We are closed on 25 December.',
}
const fernhouse = {
  title: 'Visitor hours and admission',
  category: 'hours',
  content:
    'Fernhouse Conservatory opens Tuesday to Sunday 10:00 to 17:00; it is closed on Monday. Adults pay $13, children aged 5 to 15 pay $5. Visitors may take photographs without flash.',
}
const frostFair = {
  title: 'Dates and opening hours',
  category: 'hours',
  content:
    'The 2026 Pinecrest Frost Fair runs from 27 November 2026 to 3 January 2027. Opening hours are Monday to Thursday 16:00 to 21:00, Friday and Saturday 12:00 to 23:00, and Sunday 12:00 to 20:00. The fair is closed on 24 and 25 December. Last entry is 30 minutes before closing.',
}
const manualFormat = {
  title: 'Hours and season',
  content:
    'Hours: 10:30am-6:30pm daily, June 5-August 23\nThe 2026 season ended August 23; 2027 dates are not announced yet.',
}
const dailyNewYork = { title: 'Hours', content: 'Hours: 9am-5pm daily\nClosed: December 25, 2026' }

const ask = 'Can I borrow a wheelchair when I arrive?'
const cue = (
  knowledge: ReadonlyArray<{ title: string; content: string; category?: string | null }>,
  now: string,
  timeZone: string | undefined,
  extra: Partial<Parameters<typeof guestTodayStatusCue>[0]> = {},
) => guestTodayStatusCue({ question: ask, now: new Date(now), timeZone, knowledge, ...extra })

describe('guestTodayStatusQuestion', () => {
  it.each(['May 10', '10 May', '2027-04-10'])(
    'does not inject today closure into an explicit date plan: %s',
    (date) => {
      expect(
        cue([{ title: 'Hours', content: 'Open daily 10am-4pm.' }], '2026-10-30T20:00:00Z', 'UTC', {
          question: `I am planning to visit ${date}. What can we do?`,
        }),
      ).toBeNull()
    },
  )

  it.each([
    'Can I borrow a wheelchair when I arrive?',
    'Is the cafe busy today?',
    'What should we see first when we get there?',
    'Can we rent a stroller?',
    "We're coming with two kids, where should we park?",
    'We are planning to visit, is there a cloakroom?',
    "We're on our way, is parking free?",
    'Anything good to do this afternoon?',
    'Is it open now?',
    'May I visit today?',
    'We may be planning to visit, can we rent a stroller?',
  ])('turns on for today, arrival or plan wording: %s', (question) => {
    expect(guestTodayStatusQuestion(question)).toBe(true)
  })

  it.each([
    'Can I borrow a wheelchair tomorrow?',
    'Is it open on Saturday?',
    'Are you open on December 26?',
    'I am planning to visit May 10. What can we do?',
    'I am planning to visit 10 May. What can we do?',
    'I am planning to visit 2027-04-10. What can we do?',
    'What animals live here?',
    'Can I bring a dog?',
    'We visited last year, is the maze still there?',
    'Are you open over the Christmas holidays?',
    'Can we rent a stroller next week?',
    'What are the usual opening hours?',
    '',
  ])('stays off without today implied or with another time: %s', (question) => {
    expect(guestTodayStatusQuestion(question)).toBe(false)
  })
})

describe('guestTodayStatusCue: closed today', () => {
  it('says a winter Monday is a closed day and gives the next posted opening', () => {
    // Monday, November 23, 2026 at 10:05 in London (GMT).
    const result = cue([brackenmoor], '2026-11-23T10:05:00Z', 'Europe/London')
    expect(result).toContain('Today is Monday, November 23, 2026.')
    expect(result).toContain(
      'The venue is closed today: its posted hours say it is closed on Mondays in the winter season.',
    )
    expect(result).toContain('Its next posted opening is Wednesday, November 25 at 10 am.')
    expect(result).toContain('say this first')
    expect(result).toContain('venue-wide schedule')
  })

  it('says nothing on an open summer Monday', () => {
    expect(cue([brackenmoor], '2026-06-15T09:05:00Z', 'Europe/London')).toBeNull()
  })

  it('refuses inside a stated exception period', () => {
    // Monday, December 21, 2026 falls inside "except from 21 to 31 December 2026".
    expect(cue([brackenmoor], '2026-12-21T11:00:00Z', 'Europe/London')).toBeNull()
  })

  it('says an explicitly closed weekday is closed', () => {
    const result = cue([fernhouse], '2026-11-16T15:00:00Z', 'America/New_York', {
      venueName: 'Fernhouse Conservatory',
    })
    expect(result).toContain('closed on Mondays')
    expect(result).toContain('Its next posted opening is Tuesday, November 17 at 10 am.')
  })

  it('says an unlisted weekday is not an operating day when every opening names days', () => {
    const result = cue(
      [{ title: 'Opening hours', content: 'Hours: 10am-5pm Wednesday to Sunday' }],
      '2026-11-16T15:00:00Z',
      'America/New_York',
    )
    expect(result).toContain('its posted hours list no opening on Mondays')
    expect(result).toContain('Wednesday, November 18 at 10 am')
  })

  it('says a listed closed date is closed', () => {
    const result = cue([dailyNewYork], '2026-12-25T15:00:00Z', 'America/New_York')
    expect(result).toContain('its posted hours list today as a closed date')
    expect(result).toContain('Saturday, December 26 at 9 am')
  })

  it('handles closed dates and a run spanning the year boundary', () => {
    const params = { venueName: 'Pinecrest Frost Fair' }
    const christmas = cue([frostFair], '2026-12-25T13:00:00Z', 'Europe/London', params)
    expect(christmas).toContain('closed date')
    expect(christmas).toContain('Saturday, December 26 at noon')
    expect(cue([frostFair], '2027-01-02T13:00:00Z', 'Europe/London', params)).toBeNull()
    const after = cue([frostFair], '2027-01-04T13:00:00Z', 'Europe/London', params)
    expect(after).toContain('its posted season or run dates do not include today')
    expect(after).toContain('The posted hours give no next opening date.')
  })

  it('refuses the frost fair when the run names a different subject than the venue', () => {
    expect(
      cue([frostFair], '2027-01-04T13:00:00Z', 'Europe/London', { venueName: 'Elmside Market' }),
    ).toBeNull()
  })
})

describe('guestTodayStatusCue: outside the season', () => {
  it('says the season ended (manual hours format)', () => {
    const result = cue([manualFormat], '2026-10-26T15:00:00Z', 'America/Chicago')
    expect(result).toContain('its posted season or run dates do not include today')
    expect(result).toContain('The posted hours give no next opening date.')
    // The last season day itself is still governed by the daily hours.
    expect(cue([manualFormat], '2026-08-23T17:00:00Z', 'America/Chicago')).toBeNull()
  })

  it('says the season has not started and names the explicit-year first opening', () => {
    const result = cue(
      [
        {
          title: 'Hours',
          content:
            'Hours: 10am-5pm daily, May 1-September 30, 2027\nThe 2027 season opens May 1, 2027.',
        },
      ],
      '2027-04-20T15:00:00Z',
      'America/Chicago',
    )
    expect(result).toContain('its posted season or run dates do not include today')
    expect(result).toContain('Saturday, May 1 at 10 am')
  })

  it('reads "closed for the season after" as a season end', () => {
    const result = cue(
      [
        {
          title: 'Hours',
          content:
            'Hours: 11am-7pm daily, May 23-September 7\nClosed: for the season after Monday, September 7, 2026',
        },
      ],
      '2026-10-26T17:00:00Z',
      'America/New_York',
    )
    expect(result).toContain('do not include today')
  })

  it('does not report a far-off opening of an annual (yearless) season', () => {
    const result = cue(
      [
        {
          title: 'Hours',
          content: 'Hours: 10am-5pm daily, May 1-September 30\nThe 2026 season ended September 30.',
        },
      ],
      '2026-11-20T15:00:00Z',
      'America/Chicago',
    )
    expect(result).toContain('The posted hours give no next opening date.')
  })

  it('does not call a date past the posted range closed without explicit season wording', () => {
    // Like a zoo whose posted hours run to May 28: afterwards its hours are unknown, not closed.
    const zoo = {
      title: 'Hours and season',
      category: 'Visitor essentials',
      content:
        'Brookhollow Zoo is open daily, 10 a.m.-4 p.m., September 8, 2026-May 28, 2027. Last paid admission is 3:30 p.m. Closed: December 25, 2026. These are regular zoo hours.',
    }
    const params = { question: "What are the zoo's hours today?", venueName: 'Brookhollow Zoo' }
    expect(cue([zoo], '2027-06-12T17:00:00Z', 'America/Chicago', params)).toBeNull()
    expect(cue([zoo], '2026-12-25T17:00:00Z', 'America/Chicago', params)).toContain('closed date')
    expect(cue([zoo], '2026-12-26T22:30:00Z', 'America/Chicago', params)).toContain('have ended')
  })

  it('does not treat a singular "Hour" programme title as a second hours topic', () => {
    const owlHour = {
      title: 'Owl Hour',
      category: 'tickets',
      content: 'Owl Hour runs only from April to October.',
    }
    expect(cue([brackenmoor, owlHour], '2026-11-23T10:05:00Z', 'Europe/London')).toContain(
      'closed on Mondays',
    )
  })

  it('refuses February 29 against a yearless season ending February 28', () => {
    expect(cue([brackenmoor], '2028-02-29T11:00:00Z', 'Europe/London')).toBeNull()
  })
})

describe('guestTodayStatusCue: after closing', () => {
  const saturday = (utc: string) =>
    cue([fernhouse], utc, 'America/New_York', {
      question: "We're on our way, is parking free?",
      venueName: 'Fernhouse Conservatory',
    })

  it('says today has ended after the posted closing time', () => {
    // Saturday, November 14, 2026 at 5:30 pm EST.
    const result = saturday('2026-11-14T22:30:00Z')
    expect(result).toContain("The venue's posted hours for today (10 am to 5 pm) have ended")
    expect(result).toContain('Sunday, November 15 at 10 am')
  })

  it('treats the closing minute itself as ended', () => {
    expect(saturday('2026-11-14T22:00:00Z')).toContain('have ended')
  })

  it('never says open: during or before posted hours it returns null', () => {
    expect(saturday('2026-11-14T21:59:00Z')).toBeNull()
    expect(saturday('2026-11-14T14:00:00Z')).toBeNull()
  })

  it('uses the post-DST offset on the autumn change day', () => {
    // November 1, 2026: New York is UTC-5 after 2 am. 21:30Z is 4:30 pm, 22:30Z is 5:30 pm.
    expect(cue([dailyNewYork], '2026-11-01T21:30:00Z', 'America/New_York')).toBeNull()
    expect(cue([dailyNewYork], '2026-11-01T22:30:00Z', 'America/New_York')).toContain('have ended')
  })

  it('uses the summer offset on the spring change day', () => {
    // March 8, 2026: New York is UTC-4 after 2 am. 20:30Z is 4:30 pm, 21:00Z is 5 pm.
    expect(cue([dailyNewYork], '2026-03-08T20:30:00Z', 'America/New_York')).toBeNull()
    expect(cue([dailyNewYork], '2026-03-08T21:00:00Z', 'America/New_York')).toContain('have ended')
  })

  it('switches day at local midnight, not UTC midnight', () => {
    const opts = { venueName: 'Fernhouse Conservatory' }
    // Sunday, November 22, 2026 at 11:59 pm in Los Angeles: Sunday hours ended.
    expect(cue([fernhouse], '2026-11-23T07:59:00Z', 'America/Los_Angeles', opts)).toContain(
      'Today is Sunday, November 22, 2026.',
    )
    // Two minutes later it is Monday locally: a closed day.
    expect(cue([fernhouse], '2026-11-23T08:01:00Z', 'America/Los_Angeles', opts)).toContain(
      'closed on Mondays',
    )
    // Auckland is already on Monday while UTC is still Sunday.
    expect(cue([fernhouse], '2026-11-22T11:30:00Z', 'Pacific/Auckland', opts)).toContain(
      'Today is Monday, November 23, 2026.',
    )
  })
})

describe('guestTodayStatusCue: refusals', () => {
  const closedMonday = '2026-11-16T15:00:00Z'
  const opts = { venueName: 'Fernhouse Conservatory' }

  it('refuses without a usable time zone', () => {
    expect(cue([fernhouse], closedMonday, undefined, opts)).toBeNull()
    expect(cue([fernhouse], closedMonday, 'Not/AZone', opts)).toBeNull()
  })

  it('refuses when any active update exists', () => {
    expect(
      cue([fernhouse], closedMonday, 'America/New_York', {
        ...opts,
        activeUpdates: [{ title: 'Parking' }],
      }),
    ).toBeNull()
  })

  it('refuses with several hours topics or none', () => {
    expect(
      cue(
        [fernhouse, { title: 'Cafe hours', content: 'Hours: 9am-3pm daily' }],
        closedMonday,
        'America/New_York',
        opts,
      ),
    ).toBeNull()
    expect(
      cue(
        [{ title: 'Parking', content: 'Closed: Mondays' }],
        closedMonday,
        'America/New_York',
        opts,
      ),
    ).toBeNull()
  })

  it('refuses when the gate is off', () => {
    expect(
      cue([fernhouse], closedMonday, 'America/New_York', {
        ...opts,
        question: 'What plants grow here?',
      }),
    ).toBeNull()
  })

  it('control: the refusal fixtures fire without the offending wording', () => {
    expect(
      cue(
        [{ title: 'Hours', content: 'Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays' }],
        closedMonday,
        'America/New_York',
        opts,
      ),
    ).toContain('closed on Mondays')
  })

  it.each([
    ['variable holiday', 'Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays and Thanksgiving Day'],
    [
      'public holiday rule',
      'Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays. When a Monday is a public holiday we open 10am-5pm.',
    ],
    ['weather wording', 'Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays, and in bad weather'],
    [
      'an unrecognised schedule sentence',
      'Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays\nThe miniature railway runs on Sundays at 11:00 and 14:00.',
    ],
    [
      'an outlet subject',
      'The house is open Tuesday to Sunday 11:00 to 17:00 and closed on Mondays.',
    ],
    ['a labeled outlet subject', 'Hours: Tea Room, 10am-4pm Tuesday to Sunday\nClosed: Mondays'],
    [
      'two generic subjects',
      'The museum is closed on Mondays. The park is open daily 8:00 to 18:00.',
    ],
    [
      'a contradictory weekday and date',
      'Hours: 10am-5pm daily\nClosed: Tuesday, November 16, 2026',
    ],
    ['a closing time past midnight', 'Hours: 6pm-1am Tuesday to Sunday\nClosed: Mondays'],
    ['a closing at midnight', 'Hours: 6pm-midnight Tuesday to Sunday\nClosed: Mondays'],
    ['an open rule contradicting a closed weekday', 'Hours: 10am-5pm daily\nClosed: Mondays'],
    [
      'mixed scoped and unscoped hours',
      'Hours: 10am-5pm daily\nHours: 9am-6pm daily, June 1-August 31',
    ],
    ['split hours with a gap', 'Hours: 10am-1pm and 2pm-5pm Monday to Sunday'],
  ])('refuses %s', (_label, content) => {
    expect(cue([{ title: 'Hours', content }], closedMonday, 'America/New_York', opts)).toBeNull()
  })

  it('parses fixed-date holidays only inside a closed-date list', () => {
    const schedule = parseVenueSchedule(
      "Hours: 10am-4pm daily\nClosed: Christmas Eve, Christmas Day and New Year's Day",
    )
    expect(schedule?.closedDates).toEqual([
      { m: 12, d: 24 },
      { m: 12, d: 25 },
      { m: 1, d: 1 },
    ])
    expect(
      parseVenueSchedule('Hours: 10am-4pm daily\nChristmas lights run in the evening.'),
    ).toBeNull()
  })

  it('parses labeled weekday lists with commas', () => {
    const schedule = parseVenueSchedule(
      'Hours: 10am-4pm Monday, Tuesday, Thursday and Friday\nClosed: Wednesday, Saturday and Sunday',
    )
    expect([...(schedule?.openRules[0]?.days ?? [])]).toEqual([0, 1, 3, 4])
    expect([...(schedule?.closedWeekdays[0]?.days ?? [])]).toEqual([2, 5, 6])
  })

  it('ignores admission and last-entry sentences but not schedule sentences', () => {
    expect(parseVenueSchedule(fernhouse.content, 'Fernhouse Conservatory')).not.toBeNull()
    expect(
      parseVenueSchedule(
        `${fernhouse.content} Guided tours start at 2pm.`,
        'Fernhouse Conservatory',
      ),
    ).toBeNull()
  })

  it('never asserts that the venue is open', () => {
    const outputs = [
      cue([brackenmoor], '2026-11-23T10:05:00Z', 'Europe/London'),
      cue([manualFormat], '2026-10-26T15:00:00Z', 'America/Chicago'),
      cue([dailyNewYork], '2026-11-01T22:30:00Z', 'America/New_York'),
    ]
    for (const output of outputs) {
      expect(output).not.toBeNull()
      expect(output).not.toMatch(/\b(?:is|are) open\b/u)
      expect(output).not.toMatch(/[–—]/u)
    }
  })
})
