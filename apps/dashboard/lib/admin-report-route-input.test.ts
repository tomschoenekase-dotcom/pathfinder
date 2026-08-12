import { describe, expect, it } from 'vitest'

import { resolveAdminReportRouteInput } from './admin-report-route-input'

const now = new Date('2026-08-11T15:00:00.000Z')

describe('admin report route input', () => {
  it('accepts an exact calendar range and complete stable cursor', () => {
    const result = resolveAdminReportRouteInput(
      {
        weekStart: '2026-08-01',
        weekEnd: '2026-08-07',
        cursorWeekStart: '2026-07-25T00:00:00.000Z',
        cursorId: 'report_1',
      },
      now,
    )

    expect(result).toMatchObject({
      warning: null,
      cursor: { weekStart: '2026-07-25T00:00:00.000Z', id: 'report_1' },
    })
    expect(result.weekStart.toISOString()).toBe('2026-08-01T00:00:00.000Z')
    expect(result.weekEnd.toISOString()).toBe('2026-08-07T23:59:59.999Z')
  })

  it.each([
    { weekStart: 'garbage', weekEnd: '2026-08-07' },
    { weekStart: '2026-02-30', weekEnd: '2026-08-07' },
    { weekStart: '2026-08-08', weekEnd: '2026-08-07' },
  ])('falls back safely for malformed or reversed dates: %o', (query) => {
    const result = resolveAdminReportRouteInput(query, now)
    expect(result.warning).toContain('date filter was invalid')
    expect(result.weekStart.toISOString()).toBe('2026-08-05T00:00:00.000Z')
    expect(result.weekEnd.toISOString()).toBe(now.toISOString())
  })

  it.each([
    { cursorWeekStart: '2026-07-25T00:00:00.000Z' },
    { cursorId: 'report_1' },
    { cursorWeekStart: 'not-a-date', cursorId: 'report_1' },
    { cursorWeekStart: '2026-07-25T00:00:00.000Z', cursorId: 'x'.repeat(192) },
  ])('falls back to the newest page for an invalid cursor: %o', (query) => {
    const result = resolveAdminReportRouteInput(query, now)
    expect(result.cursor).toBeNull()
    expect(result.warning).toContain('cursor was invalid')
  })
})
