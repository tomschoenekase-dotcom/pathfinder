import { describe, expect, it } from 'vitest'
import { guestRecordOpeningFacts } from './guest-schedule'

const facts = (content: string, now = '2026-11-01T15:30:00Z', timeZone = 'America/Chicago') =>
  guestRecordOpeningFacts({ title: 'Maple Gallery', content, now: new Date(now), timeZone })

describe('per-record posted opening facts', () => {
  it('covers before opening, within the interval and at/after close in venue time', () => {
    expect(facts('Hours: 10am-5pm daily')[0]).toContain('opens in 30 minutes')
    expect(facts('Hours: 10am-5pm daily', '2026-11-01T16:20:00Z')[0]).toContain(
      'closes in 400 minutes',
    )
    expect(facts('Hours: 10am-5pm daily', '2026-11-01T23:00:00Z')[0]).toContain('Already closed')
  })
  it('provides separate dated intervals for tomorrow and multi-day planning', () => {
    const result = facts('Hours: 10am-5pm Tuesday to Sunday\nClosed: Mondays')
    expect(result).toHaveLength(8)
    expect(result[0]).toContain('Sunday, November 1, 2026: 10 am to 5 pm')
    expect(result[1]).toContain('Monday, November 2, 2026: closed')
    expect(result[2]).toContain('Tuesday, November 3, 2026: 10 am to 5 pm')
    expect(result[1]).not.toContain('request time')
  })
  it('does not infer closure beyond a dated schedule or turn unknown time into all-day opening', () => {
    expect(facts('Hours: 10am-5pm daily, October 1 to October 31, 2026')[0]).toContain('unknown')
    expect(facts('Hours: weekends')[0]).toContain('opening and closing times unknown')
  })
  it('treats missing weekdays as unknown while preserving explicit closures and exclusive days', () => {
    const partial = facts('Hours: Sunday 11am-5pm')
    expect(partial[0]).toContain('11 am to 5 pm')
    for (const day of partial.slice(1, 7)) {
      expect(day).toContain('hours unknown (not a closure)')
      expect(day).not.toContain(': closed')
    }
    const closed = facts('Hours: Sunday 11am-5pm\nClosed: Monday')
    expect(closed[1]).toContain(': closed')
    expect(closed[2]).toContain('hours unknown')
    expect(facts('Hours: Sunday only 11am-5pm')[1]).toContain(': closed')
    expect(partial[7]).toContain('Sunday, November 8, 2026: 11 am to 5 pm')
  })
  it('grounds requested dates beyond the rolling calendar without borrowing a weekday interval', () => {
    const result = guestRecordOpeningFacts({
      title: 'Maple Gallery',
      content: 'Hours: Sunday 11am-5pm',
      now: new Date('2026-11-01T15:30:00Z'),
      timeZone: 'America/Chicago',
      question: 'Can we visit on November 16, 2026 and November 22, 2026?',
    })
    expect(result.find((line) => line.startsWith('Monday, November 16, 2026:'))).toContain(
      'unknown',
    )
    expect(result.find((line) => line.startsWith('Sunday, November 22, 2026:'))).toContain(
      '11 am to 5 pm',
    )
    expect(result.slice(8).every((line) => !line.includes('request time'))).toBe(true)
  })
  it('uses venue-local dates across midnight and never guesses a year for extra dates', () => {
    const input = {
      title: 'Maple Gallery',
      content: 'Hours: Thursday 11am-5pm',
      now: new Date('2027-01-01T00:30:00Z'),
      timeZone: 'America/Chicago',
    }
    const partial = guestRecordOpeningFacts({ ...input, question: 'What about January 20?' })
    expect(partial).toHaveLength(8)
    expect(partial[0]).toContain('Thursday, December 31, 2026: 11 am to 5 pm')
    const explicit = guestRecordOpeningFacts({ ...input, question: 'What about January 21, 2027?' })
    expect(explicit.at(-1)).toContain('Thursday, January 21, 2027: 11 am to 5 pm')
    expect(explicit.at(-1)).not.toContain('request time')
  })
  it.each([
    'Hours: 10am-5pm daily\nClosed for repairs.',
    'Hours: 10am-5pm daily\nCondition: Open only when staff are present.',
    'Hours: 10am-5pm daily\nRestriction: Opening depends on weather.',
    'Hours: 10am-5pm daily\nException: Early closure for private events.',
    'Hours: 10am-5pm daily\nStatus: Closed for repairs.',
    'Hours: 10am-5pm daily\nHours: noon-4pm daily',
    'Hours: Sunday 11am-5pm only with staff',
    'Hours: Sunday 11am-5pm only for ticket holders',
    'Hours: Sunday only 11am-5pm when staff are present',
    'Hours: 10am-5pm on park days',
    'Hours: 10pm-2am daily',
    'Duration: 20 minutes.\nBooking: Arrive by 10am.',
  ])('refuses ambiguous or overridden schedule %s', (content) => {
    expect(
      facts(content).some((line) => line.includes('Within posted') || line.includes('opens in')),
    ).toBe(false)
  })
  it('has no host clock/timezone fallback', () => {
    expect(facts('Hours: 10am-5pm daily', 'invalid')).toEqual([])
    expect(facts('Hours: 10am-5pm daily', undefined, 'invalid')).toEqual([])
  })
  it('refuses an ambiguous half-hour transition boundary', () => {
    expect(
      facts('Hours: 1:45am-5pm daily', '2026-04-04T13:00:00Z', 'Australia/Lord_Howe')[0],
    ).not.toContain('opens in')
  })
  it('uses elapsed minutes across a daylight-saving transition', () => {
    expect(facts('Hours: 10am-5pm daily', '2026-11-01T05:30:00Z')[0]).toContain(
      'opens in 630 minutes',
    )
    expect(facts('Hours: 10am-5pm daily', '2026-03-08T06:30:00Z')[0]).toContain(
      'opens in 510 minutes',
    )
  })
})
