import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WEEKLY_REPORT_TITLE,
  effectiveWeeklyReportTitle,
  generationRequestHash,
} from './generation-request-identity'

const rangeStart = new Date('2026-08-01T00:00:00.000Z')
const rangeEnd = new Date('2026-08-08T00:00:00.000Z')

describe('generation request identity', () => {
  it('is stable for normalized analysis timestamps and changes with durable input', () => {
    const first = generationRequestHash({
      kind: 'ANSWER_ANALYSIS',
      venueId: 'venue_1',
      rangeStart,
      rangeEnd,
    })
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(
      generationRequestHash({
        kind: 'ANSWER_ANALYSIS',
        venueId: 'venue_1',
        rangeStart: new Date('2026-07-31T19:00:00.000-05:00'),
        rangeEnd,
      }),
    ).toBe(first)
    expect(
      generationRequestHash({
        kind: 'ANSWER_ANALYSIS',
        venueId: 'venue_2',
        rangeStart,
        rangeEnd,
      }),
    ).not.toBe(first)
  })

  it('hashes the effective report title and treats blank as the server default', () => {
    expect(effectiveWeeklyReportTitle('  ')).toBe(DEFAULT_WEEKLY_REPORT_TITLE)
    expect(
      generationRequestHash({
        kind: 'WEEKLY_REPORT',
        venueId: 'venue_1',
        rangeStart,
        rangeEnd,
      }),
    ).toBe(
      generationRequestHash({
        kind: 'WEEKLY_REPORT',
        venueId: 'venue_1',
        rangeStart,
        rangeEnd,
        title: ` ${DEFAULT_WEEKLY_REPORT_TITLE} `,
      }),
    )
  })

  it('separates analysis and report request domains', () => {
    expect(
      generationRequestHash({
        kind: 'ANSWER_ANALYSIS',
        venueId: 'venue_1',
        rangeStart,
        rangeEnd,
      }),
    ).not.toBe(
      generationRequestHash({
        kind: 'WEEKLY_REPORT',
        venueId: 'venue_1',
        rangeStart,
        rangeEnd,
      }),
    )
  })
})
