/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  createDashboardCaller: vi.fn(),
  getDailyStats: vi.fn(),
  getVisitorStats: vi.fn(),
  getWeeklyThemes: vi.fn(),
  getTopQuestions: vi.fn(),
  getPlaceInterest: vi.fn(),
  listVenues: vi.fn(),
}))

vi.mock('../../../lib/server-caller', () => ({
  createDashboardCaller: mocks.createDashboardCaller,
}))

import AnalyticsPage from './page'

describe('AnalyticsPage reliability wiring', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('passes tenant daily rollups and venue names into the 30-day reliability view', async () => {
    mocks.getDailyStats.mockResolvedValue([
      {
        venueId: 'venue_1',
        date: new Date('2026-08-08T00:00:00.000Z'),
        metric: 'chat_responses',
        value: 5,
      },
      {
        venueId: 'venue_1',
        date: new Date('2026-08-08T00:00:00.000Z'),
        metric: 'chat_total_p50_ms',
        value: 500,
      },
      {
        venueId: 'venue_1',
        date: new Date('2026-08-08T00:00:00.000Z'),
        metric: 'chat_total_p95_ms',
        value: 950,
      },
    ])
    mocks.getVisitorStats.mockResolvedValue({ totalMessages: 7, totalSessions: 3 })
    mocks.getWeeklyThemes.mockResolvedValue({ themes: [], weekStart: null, weekEnd: null })
    mocks.getTopQuestions.mockResolvedValue([])
    mocks.getPlaceInterest.mockResolvedValue([])
    mocks.listVenues.mockResolvedValue([{ id: 'venue_1', name: 'Science Museum' }])
    mocks.createDashboardCaller.mockResolvedValue({
      analytics: {
        getDailyStats: mocks.getDailyStats,
        getVisitorStats: mocks.getVisitorStats,
        getWeeklyThemes: mocks.getWeeklyThemes,
        getTopQuestions: mocks.getTopQuestions,
        getPlaceInterest: mocks.getPlaceInterest,
      },
      venue: { list: mocks.listVenues },
    })

    render(await AnalyticsPage())

    expect(mocks.createDashboardCaller).toHaveBeenCalledWith('/analytics')
    expect(mocks.getDailyStats).toHaveBeenCalledWith({ days: 30 })
    const table = screen.getByRole('table', {
      name: 'Science Museum guest chat reliability percentiles for 2026-08-08',
    })
    const completedRow = within(table).getByRole('row', { name: /Completed response/u })
    expect(within(completedRow).getByText('500 ms')).toBeTruthy()
    expect(within(completedRow).getByText('950 ms')).toBeTruthy()
  })
})
