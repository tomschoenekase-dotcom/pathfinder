import { describe, expect, it } from 'vitest'

import { guestBeforeOpeningCue } from './guest-before-opening'

const knowledge = [
  {
    title: 'Hours and operating calendar',
    content:
      'The museum and park keep separate hours.\nHours: Museum, 10am-4pm Monday, Tuesday, Thursday, Friday and Saturday; noon-4pm Sunday\nClosed: Museum, every Wednesday\nHours: Park, dawn to dusk every day, Monday-Sunday',
  },
]

describe('guestBeforeOpeningCue', () => {
  const singleSchedule = [{ title: 'Hours', content: 'Hours: Museum, noon-4pm Sunday' }]
  const beforeOpening = {
    now: new Date('2026-10-11T15:00:00Z'),
    timeZone: 'America/New_York',
  }

  it.each([
    ['Museum', 'museum'],
    ['Museum', 'Ｍｕｓｅｕｍ'],
    ['East Park', 'East   Park'],
    ['East Park', ' east\tpark '],
    ['Museum', 'Museum'],
  ])('abstains when normalized schedule subjects conflict: %s / %s', (subject, alias) => {
    expect(
      guestBeforeOpeningCue({
        ...beforeOpening,
        question: `Is the ${subject} open now?`,
        knowledge: [
          {
            title: 'Hours',
            content: `Hours: ${subject}, noon-4pm Sunday\nHours: ${alias}, 10am-4pm Sunday`,
          },
        ],
      }),
    ).toBeNull()
  })

  it.each([
    'Is the cafe open now?',
    'Is the museum cafe open now?',
    "Is the museum's cafe open now?",
    'Is the cafe at the museum open now?',
    'Are the museum and cafe open now?',
    'Is the museum open now, and what about the cafe?',
    'Is the museum open now? Is the cafe open now?',
    'Is the museum open now or the park?',
    'Are you open now?',
  ])('does not lend the sole posted schedule to another or unresolved subject: %s', (question) => {
    expect(
      guestBeforeOpeningCue({ ...beforeOpening, question, knowledge: singleSchedule }),
    ).toBeNull()
  })

  it('does not borrow venue hours when a public outlet record explicitly has unknown hours', () => {
    expect(
      guestBeforeOpeningCue({
        ...beforeOpening,
        question: 'Is the museum cafe open now?',
        knowledge: [
          ...singleSchedule,
          {
            title: 'Museum cafe',
            content: 'Food outlets keep separate hours. This menu provides no daily opening times.',
          },
        ],
      }),
    ).toBeNull()
  })

  it.each(['Museum Cafe', "Visitor's Gallery", 'East Park'])(
    'uses the exact posted subject without inferring its category: %s',
    (subject) => {
      expect(
        guestBeforeOpeningCue({
          ...beforeOpening,
          question: `Is the ${subject} open right now?`,
          knowledge: [{ title: 'Hours', content: `Hours: ${subject}, noon-4pm Sunday` }],
        }),
      ).toContain(`${subject} is closed now`)
    },
  )

  it('proves that the museum is closed before its Sunday noon opening in local time', () => {
    const cue = guestBeforeOpeningCue({
      question: 'Is the museum open right now?',
      now: new Date('2026-10-11T15:00:00Z'),
      timeZone: 'America/New_York',
      knowledge,
    })
    expect(cue).toContain("Sunday before Museum's regular noon opening time")
    expect(cue).toContain('Museum is closed now')
  })

  it('does not assert whether the museum is open at or after noon', () => {
    expect(
      guestBeforeOpeningCue({
        question: 'Is the museum open right now?',
        now: new Date('2026-10-11T16:00:00Z'),
        timeZone: 'America/New_York',
        knowledge,
      }),
    ).toBeNull()
  })

  it('does not apply museum hours to the park', () => {
    expect(
      guestBeforeOpeningCue({
        question: 'Is the park open right now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge,
      }),
    ).toBeNull()
  })

  it('abstains on a venue-wide question when named areas have separate hours', () => {
    expect(
      guestBeforeOpeningCue({
        question: 'Are you open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge,
      }),
    ).toBeNull()
    expect(
      guestBeforeOpeningCue({
        question: 'Are the museum and park open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge,
      }),
    ).toBeNull()
  })

  it("abstains when separate records describe different areas' hours", () => {
    expect(
      guestBeforeOpeningCue({
        question: 'Are you open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge: [
          { title: 'Museum hours', content: 'Hours: Museum, noon-4pm Sunday' },
          { title: 'Park hours', content: 'Hours: Park, dawn to dusk Sunday' },
        ],
      }),
    ).toBeNull()
  })

  it('abstains without a zone or when a live update may override hours', () => {
    const base = {
      question: 'Are you open now?',
      now: new Date('2026-10-11T15:00:00Z'),
      knowledge,
    }
    expect(guestBeforeOpeningCue({ ...base, timeZone: undefined })).toBeNull()
    expect(
      guestBeforeOpeningCue({
        ...base,
        timeZone: 'America/New_York',
        activeUpdates: [{ title: 'Special opening hours', body: 'Open early today' }],
      }),
    ).toBeNull()
    expect(
      guestBeforeOpeningCue({
        ...base,
        question: 'Is the museum open now?',
        timeZone: 'America/New_York',
        activeUpdates: [{ title: 'Member early entry', body: 'Doors at 10am today' }],
      }),
    ).toBeNull()
  })

  it('abstains on unsupported free-form or overlapping schedules', () => {
    expect(
      guestBeforeOpeningCue({
        question: 'Are you open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge: [{ title: 'Hours', content: 'Hours: Museum, variable Sunday hours' }],
      }),
    ).toBeNull()
    expect(
      guestBeforeOpeningCue({
        question: 'Are you open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge: [
          {
            title: 'Hours',
            content: 'Hours: Museum, noon-4pm Sunday; 9am-1pm Sunday',
          },
        ],
      }),
    ).toBeNull()
    expect(
      guestBeforeOpeningCue({
        question: 'Is the museum open now?',
        now: new Date('2026-10-11T15:00:00Z'),
        timeZone: 'America/New_York',
        knowledge: [
          { title: 'Museum hours', content: 'Hours: Museum, noon-4pm Sunday May-September' },
        ],
      }),
    ).toBeNull()
  })
})
