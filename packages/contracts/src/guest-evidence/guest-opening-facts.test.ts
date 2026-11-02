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
    expect(result).toHaveLength(7)
    expect(result[0]).toContain('Sunday, November 1, 2026: 10 am to 5 pm')
    expect(result[1]).toContain('Monday, November 2, 2026: closed')
    expect(result[2]).toContain('Tuesday, November 3, 2026: 10 am to 5 pm')
    expect(result[1]).not.toContain('request time')
  })
  it('does not infer closure beyond a dated schedule or turn unknown time into all-day opening', () => {
    expect(facts('Hours: 10am-5pm daily, October 1 to October 31, 2026')[0]).toContain('unknown')
    expect(facts('Hours: weekends')[0]).toContain('opening and closing times unknown')
  })
  it.each([
    'Hours: 10am-5pm daily\nClosed for repairs.',
    'Hours: 10am-5pm daily\nCondition: Open only when staff are present.',
    'Hours: 10am-5pm daily\nRestriction: Opening depends on weather.',
    'Hours: 10am-5pm daily\nException: Early closure for private events.',
    'Hours: 10am-5pm daily\nStatus: Closed for repairs.',
    'Hours: 10am-5pm daily\nHours: noon-4pm daily',
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
