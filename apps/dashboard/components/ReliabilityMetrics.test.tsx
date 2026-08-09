/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ReliabilityMetrics } from './ReliabilityMetrics'

const venues = [
  { id: 'venue_1', name: 'Science Museum' },
  { id: 'venue_2', name: 'History Center' },
  { id: 'venue_3', name: 'Art Gallery' },
]

function row(venueId: string, date: string, metric: string, value: number) {
  return { venueId, date: new Date(`${date}T00:00:00.000Z`), metric, value }
}

describe('ReliabilityMetrics', () => {
  afterEach(cleanup)

  it('shows each venue latest active day with exact p50/p95 and sample context', () => {
    render(
      <ReliabilityMetrics
        venues={venues}
        rows={[
          row('venue_1', '2026-08-07', 'chat_responses', 4),
          row('venue_1', '2026-08-07', 'chat_total_p50_ms', 900),
          row('venue_1', '2026-08-07', 'chat_total_p95_ms', 1800),
          row('venue_1', '2026-08-08', 'chat_responses', 8),
          row('venue_1', '2026-08-08', 'chat_fallback_rate_bps', 1250),
          row('venue_1', '2026-08-08', 'chat_total_p50_ms', 600),
          row('venue_1', '2026-08-08', 'chat_total_p95_ms', 1200),
          row('venue_1', '2026-08-09', 'chat_responses', 0),
          row('venue_2', '2026-08-08', 'chat_responses', 3),
          row('venue_2', '2026-08-08', 'chat_total_p50_ms', 300),
          row('venue_2', '2026-08-08', 'chat_total_p95_ms', 700),
        ]}
      />,
    )

    const science = screen.getByRole('heading', { name: 'Science Museum' }).closest('article')!
    expect(within(science).getByText(/8 responses/u)).toBeTruthy()
    expect(within(science).getByText(/12\.5% fallback/u)).toBeTruthy()
    const completedRow = within(science).getByRole('row', { name: /Completed response/u })
    expect(within(completedRow).getByText('600 ms')).toBeTruthy()
    expect(within(completedRow).getByText('1,200 ms')).toBeTruthy()
    expect(within(science).queryByText('1,800 ms')).toBeNull()
    expect(
      within(science).getByRole('table', {
        name: 'Science Museum guest chat reliability percentiles for 2026-08-08',
      }),
    ).toBeTruthy()

    const history = screen.getByRole('heading', { name: 'History Center' }).closest('article')!
    const historyCompletedRow = within(history).getByRole('row', { name: /Completed response/u })
    expect(within(historyCompletedRow).getByText('300 ms')).toBeTruthy()
    expect(within(historyCompletedRow).getByText('700 ms')).toBeTruthy()
    expect(within(history).queryByText('1,200 ms')).toBeNull()

    const gallery = screen.getByRole('heading', { name: 'Art Gallery' }).closest('article')!
    expect(within(gallery).getByText(/No completed chat responses/u)).toBeTruthy()
  })

  it('labels legacy p95-only data and missing percentiles without fabricating zeroes', () => {
    render(
      <ReliabilityMetrics
        venues={[venues[0]!]}
        rows={[
          row('venue_1', '2026-08-08', 'chat_responses', 2),
          row('venue_1', '2026-08-08', 'chat_total_p95_ms', 750),
        ]}
      />,
    )

    const completedRow = screen.getByRole('row', { name: /Completed response/u })
    expect(within(completedRow).getByText('Not available')).toBeTruthy()
    expect(within(completedRow).getByText('750 ms')).toBeTruthy()
    expect(screen.queryByText('0 ms')).toBeNull()
  })

  it('has a graceful empty-venue state and states the completed-request boundary', () => {
    render(<ReliabilityMetrics venues={[]} rows={[]} />)

    expect(screen.getByText(/after an active venue is available/u)).toBeTruthy()
    expect(screen.getByText(/do not measure time to first token/u)).toBeTruthy()
  })
})
