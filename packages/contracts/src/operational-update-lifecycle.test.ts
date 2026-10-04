import { describe, expect, it } from 'vitest'

import {
  compareLiveNoticePrecedence,
  computeOperationalUpdateLifecycle,
  dateOnlyWindowToInstants,
  liveOperationalUpdateWindowWhere,
  zonedWallTimeToInstant,
} from './operational-update-lifecycle'

const startsAt = new Date('2026-07-01T05:00:00.000Z')
const expiresAt = new Date('2026-07-08T05:00:00.000Z')
const base = { status: 'PUBLISHED', isActive: true, startsAt, expiresAt }
const at = (iso: string) => new Date(iso)

describe('computeOperationalUpdateLifecycle', () => {
  it('is DRAFT regardless of isActive or window', () => {
    for (const isActive of [true, false]) {
      expect(
        computeOperationalUpdateLifecycle({ ...base, status: 'DRAFT', isActive }, at('2026-07-02')),
      ).toMatchObject({ lifecycle: 'DRAFT', guestVisibleNow: false })
    }
  })

  it('is SCHEDULED before the start and LIVE from the start instant (inclusive)', () => {
    expect(computeOperationalUpdateLifecycle(base, at('2026-06-30T23:59:59.999Z')).lifecycle).toBe(
      'SCHEDULED',
    )
    expect(computeOperationalUpdateLifecycle(base, startsAt)).toMatchObject({
      lifecycle: 'LIVE',
      guestVisibleNow: true,
      isActiveButExpired: false,
      isActiveButNotLive: false,
    })
  })

  it('expires at the expiry instant (exclusive)', () => {
    expect(computeOperationalUpdateLifecycle(base, at('2026-07-08T04:59:59.999Z')).lifecycle).toBe(
      'LIVE',
    )
    expect(computeOperationalUpdateLifecycle(base, expiresAt)).toMatchObject({
      lifecycle: 'EXPIRED',
      guestVisibleNow: false,
    })
  })

  it('flags the production incident: published, isActive true, past window', () => {
    const result = computeOperationalUpdateLifecycle(base, at('2026-10-02T12:00:00Z'))
    expect(result).toMatchObject({
      lifecycle: 'EXPIRED',
      guestVisibleNow: false,
      isActiveButExpired: true,
      isActiveButNotLive: true,
    })
    expect(result.label).toMatch(/marked active/i)
  })

  it('is ENDED when explicitly ended, even after the window (end wins over expiry)', () => {
    for (const now of ['2026-06-01', '2026-07-03', '2026-10-02']) {
      expect(
        computeOperationalUpdateLifecycle({ ...base, isActive: false }, at(now)),
      ).toMatchObject({ lifecycle: 'ENDED', guestVisibleNow: false, isActiveButExpired: false })
    }
  })

  it('accepts ISO strings and fails closed on unparseable windows', () => {
    expect(
      computeOperationalUpdateLifecycle(
        { ...base, startsAt: startsAt.toISOString(), expiresAt: expiresAt.toISOString() },
        '2026-07-03T00:00:00Z',
      ).lifecycle,
    ).toBe('LIVE')
    expect(
      computeOperationalUpdateLifecycle({ ...base, expiresAt: 'not-a-date' }, startsAt)
        .guestVisibleNow,
    ).toBe(false)
  })

  it('agrees with the guest database window filter', () => {
    const now = at('2026-07-03T00:00:00Z')
    expect(liveOperationalUpdateWindowWhere(now)).toEqual({
      status: 'PUBLISHED',
      isActive: true,
      startsAt: { lte: now },
      expiresAt: { gt: now },
    })
  })
})

describe('timezone handling', () => {
  it('America/Chicago midnight differs from UTC midnight (CDT is UTC-5)', () => {
    const { startsAt: s, expiresAt: e } = dateOnlyWindowToInstants({
      startDate: '2026-07-01',
      endDate: '2026-07-07',
      timeZone: 'America/Chicago',
    })
    expect(s.toISOString()).toBe('2026-07-01T05:00:00.000Z')
    expect(e.toISOString()).toBe('2026-07-08T05:00:00.000Z')
    const notice = { status: 'PUBLISHED', isActive: true, startsAt: s, expiresAt: e }
    // 00:30 UTC on July 1 is still June 30 evening in Chicago: not live yet.
    expect(computeOperationalUpdateLifecycle(notice, at('2026-07-01T00:30:00Z')).lifecycle).toBe(
      'SCHEDULED',
    )
    // 04:30 UTC on July 8 is still July 7 23:30 in Chicago: the last local day is still live.
    expect(computeOperationalUpdateLifecycle(notice, at('2026-07-08T04:30:00Z')).lifecycle).toBe(
      'LIVE',
    )
    expect(computeOperationalUpdateLifecycle(notice, at('2026-07-08T05:00:00Z')).lifecycle).toBe(
      'EXPIRED',
    )
  })

  it('a UTC interpretation of the same dates would expire 5 hours early for Chicago guests', () => {
    const utc = dateOnlyWindowToInstants({
      startDate: '2026-07-01',
      endDate: '2026-07-07',
      timeZone: 'UTC',
    })
    expect(utc.expiresAt.toISOString()).toBe('2026-07-08T00:00:00.000Z')
  })

  it('handles the spring-forward day (23h) and fall-back day (25h) in Chicago', () => {
    const spring = dateOnlyWindowToInstants({
      startDate: '2026-03-08',
      endDate: '2026-03-08',
      timeZone: 'America/Chicago',
    })
    expect(spring.startsAt.toISOString()).toBe('2026-03-08T06:00:00.000Z') // CST, UTC-6
    expect(spring.expiresAt.toISOString()).toBe('2026-03-09T05:00:00.000Z') // CDT, UTC-5
    expect((spring.expiresAt.getTime() - spring.startsAt.getTime()) / 3_600_000).toBe(23)

    const fall = dateOnlyWindowToInstants({
      startDate: '2026-11-01',
      endDate: '2026-11-01',
      timeZone: 'America/Chicago',
    })
    expect(fall.startsAt.toISOString()).toBe('2026-11-01T05:00:00.000Z') // CDT
    expect(fall.expiresAt.toISOString()).toBe('2026-11-02T06:00:00.000Z') // CST
    expect((fall.expiresAt.getTime() - fall.startsAt.getTime()) / 3_600_000).toBe(25)
  })

  it('moves a nonexistent spring-forward wall time past the gap and picks the first fall-back time', () => {
    expect(
      zonedWallTimeToInstant(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30 },
        'America/Chicago',
      ).toISOString(),
    ).toBe('2026-03-08T08:30:00.000Z')
    expect(
      zonedWallTimeToInstant(
        { year: 2026, month: 11, day: 1, hour: 1, minute: 30 },
        'America/Chicago',
      ).toISOString(),
    ).toBe('2026-11-01T06:30:00.000Z')
  })

  it('supports a zone east of UTC where local midnight is the previous UTC day', () => {
    const { startsAt: s } = dateOnlyWindowToInstants({
      startDate: '2026-07-01',
      endDate: '2026-07-01',
      timeZone: 'Pacific/Auckland',
    })
    expect(s.toISOString()).toBe('2026-06-30T12:00:00.000Z')
  })

  it('rejects invalid zones, malformed dates and reversed ranges', () => {
    expect(() =>
      dateOnlyWindowToInstants({
        startDate: '2026-07-01',
        endDate: '2026-07-02',
        timeZone: 'Nope/Zone',
      }),
    ).toThrow(RangeError)
    expect(() =>
      dateOnlyWindowToInstants({ startDate: '2026-02-30', endDate: '2026-03-01', timeZone: 'UTC' }),
    ).toThrow(RangeError)
    expect(() =>
      dateOnlyWindowToInstants({ startDate: '2026-07-05', endDate: '2026-07-01', timeZone: 'UTC' }),
    ).toThrow(RangeError)
  })
})

describe('compareLiveNoticePrecedence', () => {
  const n = (
    id: string,
    priority: string,
    severity: string,
    start: string,
  ): { id: string; priority: string; severity: string; startsAt: Date } => ({
    id,
    priority,
    severity,
    startsAt: at(start),
  })

  it('orders by priority, then severity, then most recent start, then id', () => {
    const notices = [
      n('e', 'NORMAL', 'INFO', '2026-07-01'),
      n('d', 'HIGH', 'WARNING', '2026-07-01'),
      n('c', 'HIGH', 'CLOSURE', '2026-06-01'),
      n('b', 'HIGH', 'CLOSURE', '2026-07-02'),
      n('a', 'HIGH', 'CLOSURE', '2026-07-02'),
      n('z', 'URGENT', 'INFO', '2026-01-01'),
    ]
    expect([...notices].sort(compareLiveNoticePrecedence).map((item) => item.id)).toEqual([
      'z',
      'a',
      'b',
      'c',
      'd',
      'e',
    ])
  })
})
