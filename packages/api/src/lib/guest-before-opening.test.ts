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
  })
})
