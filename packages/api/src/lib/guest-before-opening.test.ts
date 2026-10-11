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
  it.each([
    ['2026-10-11T15:59:50Z', '2026-10-11T16:00:05Z'],
    ['2026-10-12T03:59:50Z', '2026-10-12T04:00:05Z'],
    ['2026-11-01T05:30:00Z', '2026-11-01T06:30:00Z'],
    ['2026-03-08T06:59:50Z', '2026-03-08T07:00:05Z'],
    ['2026-10-11T15:00:00Z', '2026-10-11T15:02:00Z'],
  ])('abstains when retrieval crosses a clock boundary (%s to %s)', (observedAt, now) => {
    expect(
      guestBeforeOpeningCue({
        question: 'Is the museum open now?',
        observedAt: new Date(observedAt),
        now: new Date(now),
        timeZone: 'America/New_York',
        knowledge,
      }),
    ).toBeNull()
  })

  it('retains the cue for a fresh snapshot and rejects conflicting subject capitalization', () => {
    const base = {
      question: 'Is the museum open now?',
      observedAt: new Date('2026-10-11T15:00:00Z'),
      now: new Date('2026-10-11T15:00:10Z'),
      timeZone: 'America/New_York',
      knowledge,
    }
    expect(guestBeforeOpeningCue(base)).toContain('Museum is closed now')
    expect(
      guestBeforeOpeningCue({
        ...base,
        knowledge: [
          {
            title: 'Hours',
            content: 'Hours: Museum, noon-4pm Sunday\nHours: MUSEUM, 9am-4pm Sunday',
          },
        ],
      }),
    ).toBeNull()
  })

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
