import { describe, expect, it } from 'vitest'

import {
  buildGuestComputedFacts,
  guestHeightFacts,
  guestScheduleForDay,
  parseHeightRule,
  venueDay,
} from './guest-computed-facts'

// Fictional venues only. Times are America/New_York; October 2031 starts on a Wednesday.
describe('adversarial computed ride facts', () => {
  const directory = {
    knowledge: [
      {
        title: 'Comet',
        category: 'Rides',
        content:
          'Comet is a steel coaster.\nHeight: 48 in to ride\nMade by: Ember Works\nSize and speed: 120 ft tall; 60 mph',
      },
    ],
  }
  it('does not interpret a structure height as a zero-foot rider', () => {
    expect(guestHeightFacts(directory, 'Is Comet 120 ft tall?')).toBeNull()
  })
  it('does not carry a previous maker into a new food question', () => {
    expect(
      buildGuestComputedFacts({
        directory,
        question: 'Where can I eat?',
        previousQuestion: 'Any Intamin rides?',
        now: new Date('2031-10-01T12:00:00Z'),
      }),
    ).not.toContain('MAKER CHECK')
  })
  it('keeps a previous subject for a ride-fact follow-up', () => {
    expect(
      buildGuestComputedFacts({
        directory,
        question: 'Who made it?',
        previousQuestion: 'Tell me about Comet',
        now: new Date('2031-10-01T12:00:00Z'),
      }),
    ).toContain('Ember Works')
  })
})
const museum = {
  knowledge: [
    {
      title: 'Hours and operating calendar',
      category: 'Hours',
      content: [
        'The museum and Lantern Point Park keep separate hours.',
        'Hours: Museum, 10am-4pm Monday, Tuesday, Thursday, Friday and Saturday; noon-4pm Sunday',
        'Closed: Museum, every Wednesday',
        "Closed: Museum, Thanksgiving Day, Christmas Day, New Year's Day and Memorial Day",
        'Hours: Park, dawn to dusk every day, Monday-Sunday',
      ].join('\n'),
    },
  ],
}
const pier = {
  knowledge: [
    {
      title: 'Harbor Pier October 2031 hours',
      category: 'Hours',
      content: [
        'These dated hours apply to Harbor Pier.',
        'Hours: noon-7pm Saturday, October 11, 2031, for Pier rides.',
        'Closed: Pier rides Monday, October 13, 2031.',
        'Hours: 11am-9pm Monday, October 13, 2031, for Tide Arcade.',
      ].join('\n'),
    },
  ],
}
const village = {
  knowledge: [
    {
      title: 'Hours and operating calendar',
      category: 'Hours',
      content: [
        'Hours: 9:30am-5pm Saturdays, October 4-October 25, 2031, and Sundays, October 5 and October 12, 2031, for Harvest Days',
        'Closed: all other dates October 1-December 31, 2031, including Monday, October 13',
      ].join('\n'),
    },
  ],
}
const at = (iso: string) => new Date(iso)
const facts = (
  directory: { knowledge: Array<{ title: string; category: string; content: string }> },
  iso: string,
  question: string,
) => buildGuestComputedFacts({ question, directory, now: at(iso), timeZone: 'America/New_York' })

describe('server-computed schedule', () => {
  it('says not open yet before a later Sunday opening', () => {
    // Sunday October 12, 2031, 11:00 local.
    const text = facts(museum, '2031-10-12T15:00:00Z', 'How late are you open today?')
    expect(text).toContain('Museum: noon-4pm, not open yet; opens at noon')
    expect(text).toContain('Park: dawn to dusk')
    expect(text).not.toContain('10am-4pm')
  })

  it('lets a weekly closure override regular hours and keeps the other facility open', () => {
    // Wednesday October 15, 2031.
    const text = facts(museum, '2031-10-15T17:00:00Z', 'Are you open now?')
    expect(text).toContain('Museum: closed this day (Closed: Museum, every Wednesday)')
    expect(text).toContain('Park: dawn to dusk')
  })

  it('resolves named holidays to their dates', () => {
    const christmas = guestScheduleForDay(museum, venueDay(2031, 11, 25), null)
    expect(christmas.lines.join(' ')).toContain('Museum: closed this day')
    const thanksgiving = guestScheduleForDay(museum, venueDay(2031, 10, 27), null)
    expect(thanksgiving.lines.join(' ')).toContain('Museum: closed this day')
  })

  it('keeps separate facilities and covers every asked date', () => {
    const text = facts(
      pier,
      '2031-10-11T20:00:00Z',
      'For October 11 and 13, compare rides and the arcade.',
    )
    expect(text).toContain('Pier rides: noon-7pm, open now by the schedule, until 7pm')
    expect(text).toContain('Monday, October 13, 2031')
    expect(text).toContain('Pier rides: closed this day')
    expect(text).toContain('Tide Arcade: 11am-9pm')
  })

  it('treats plural weekdays as a weekly rule and finds the next opening', () => {
    // Monday October 13, 2031 is closed; Saturday October 18 is open.
    const text = facts(village, '2031-10-13T14:00:00Z', 'Are you open today?')
    expect(text).toContain('Closed this day')
    expect(text).toContain(
      'Next scheduled hours: Saturday, October 18, 2031: Harvest Days: 9:30am-5pm',
    )
  })

  it('says nothing for an unrelated question, a missing time zone or a venue without hours records', () => {
    expect(facts(museum, '2031-10-12T15:00:00Z', 'Tell me about the boats')).toBe('')
    expect(
      buildGuestComputedFacts({
        question: 'Are you open?',
        directory: museum,
        now: at('2031-10-12T15:00:00Z'),
      }),
    ).toBe('')
    expect(
      facts(
        { knowledge: [{ title: 'Gift shop', category: 'Shopping', content: 'Souvenirs.' }] },
        '2031-10-12T15:00:00Z',
        'Are you open now?',
      ),
    ).toBe('')
  })
})

describe('server-computed ride heights', () => {
  const rides = {
    knowledge: [
      {
        title: 'Ridge Flyer',
        category: 'Rides',
        content:
          'A family coaster.\nHeight: 42 in minimum; riders between 42 and 48 in require a supervising companion age 14 or older.',
      },
      {
        title: 'Lantern Carousel',
        category: 'Rides',
        content:
          'A gentle carousel.\nHeight: no numerical minimum height; under 48 in requires a supervising companion age 14 or older.',
      },
      { title: 'Thunder Run', category: 'Rides', content: 'A big coaster.\nHeight: 48 in minimum' },
      {
        title: 'Rain Raft',
        category: 'Rides',
        content: 'A water ride. Closed for the 2031 season.\nHeight: 36 in minimum',
      },
      {
        title: 'Ride guide',
        category: 'Overview',
        content: 'Height: 36 in minimum for some rides.\nHeight: 48 in for others.',
      },
    ],
  }

  it('reads the common Height line forms and refuses ambiguous ones', () => {
    expect(parseHeightRule(rides.knowledge[0]!.content)).toMatchObject({
      minWithCompanion: 42,
      minAlone: 48,
    })
    expect(parseHeightRule(rides.knowledge[1]!.content)).toMatchObject({
      noMinimum: true,
      minAlone: 48,
    })
    expect(parseHeightRule(rides.knowledge[2]!.content)).toMatchObject({
      minAlone: 48,
      minWithCompanion: null,
    })
    expect(parseHeightRule(rides.knowledge[4]!.content)).toBeNull()
  })

  it('compares a stated height exactly', () => {
    const text = guestHeightFacts(rides, 'My son is 46 inches. What can he ride?')!
    expect(text).toContain('Ridge Flyer: only with a qualifying companion (48 in to ride alone)')
    expect(text).toContain('Thunder Run: too short, 2 in under the 48-inch minimum')
    expect(text).toContain(
      'Rain Raft (not currently operating per its record): meets the height rule',
    )
    expect(text).not.toContain('Ride guide')
  })

  it('never turns an age into a height', () => {
    const text = guestHeightFacts(rides, 'My child is 4. Which rides can they go on?')!
    expect(text).toContain('only an age was given, so no height comparison is possible')
    expect(text).toContain(
      'Rides with no minimum height (companion rules still apply): Lantern Carousel',
    )
    expect(text).not.toMatch(/\d+-inch rider/u)
  })

  it('stays silent without a height or age', () => {
    expect(guestHeightFacts(rides, 'What is the scariest coaster?')).toBeNull()
  })
})

describe('asked weekdays', () => {
  it('reads a weekday that is today as today, and "next" as a week out', () => {
    // Saturday October 11, 2031, 1:30 pm local.
    const thisSat = facts(museum, '2031-10-11T17:30:00Z', 'Is the museum open this Saturday?')
    expect(thisSat).toContain('Today, Saturday, October 11, 2031')
    expect(thisSat).not.toContain('October 18')
    const nextSat = facts(museum, '2031-10-11T17:30:00Z', 'Is the museum open next Saturday?')
    expect(nextSat).toContain('Saturday, October 18, 2031')
  })

  it('gives a verdict for a dawn-to-dusk park only in clear daylight or clear night', () => {
    expect(facts(museum, '2031-10-12T01:30:00Z', 'Is the park open now?')).toContain(
      'Park: dawn to dusk, closed now, since it is after dusk',
    )
    expect(facts(museum, '2031-10-11T17:30:00Z', 'Is the park open now?')).toContain(
      'Park: dawn to dusk, open now by the schedule (daylight)',
    )
    expect(facts(museum, '2031-10-11T22:30:00Z', 'Is the park open now?')).toContain(
      'the exact dusk time is not in the records',
    )
  })

  it('says when a facility closed today reopens while another stays open', () => {
    const text = facts(museum, '2031-10-15T17:00:00Z', 'Are you open today?')
    expect(text).toContain('Museum next opens Thursday, October 16, 2031: Museum: 10am-4pm')
  })
})
