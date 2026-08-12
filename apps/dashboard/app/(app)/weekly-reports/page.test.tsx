/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  availability: vi.fn(),
  listReports: vi.fn(),
}))

vi.mock('../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    analytics: {
      getWeeklyReportAvailability: mocks.availability,
      listPublishedWeeklyReports: mocks.listReports,
    },
  })),
}))

import WeeklyReportsPage from './page'

describe('WeeklyReportsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.venueList.mockResolvedValue([
      { id: 'venue-1', name: 'Museum' },
      { id: 'venue-2', name: 'Gallery' },
    ])
    mocks.availability.mockResolvedValue({ enabledVenueIds: ['venue-1', 'venue-2'] })
    mocks.listReports.mockResolvedValue({ items: [], nextCursor: null })
  })

  afterEach(() => cleanup())

  it('renders a truthful disabled state without reading reports', async () => {
    mocks.availability.mockResolvedValueOnce({ enabledVenueIds: [] })

    render(await WeeklyReportsPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByRole('heading', { name: 'Reports are disabled.' })).toBeTruthy()
    expect(mocks.listReports).not.toHaveBeenCalled()
  })

  it('renders the enabled empty state for the selected venue', async () => {
    render(await WeeklyReportsPage({ searchParams: Promise.resolve({ venue: 'venue-2' }) }))

    expect(mocks.listReports).toHaveBeenCalledWith({ venueId: 'venue-2' })
    expect(screen.getByText('No weekly reports published yet.')).toBeTruthy()
  })

  it('fails closed for a requested venue that is not report-enabled', async () => {
    render(await WeeklyReportsPage({ searchParams: Promise.resolve({ venue: 'venue-disabled' }) }))

    expect(
      screen.getByRole('heading', { name: 'Reports are disabled for this venue.' }),
    ).toBeTruthy()
    expect(mocks.listReports).not.toHaveBeenCalled()
  })

  it('passes a complete bounded cursor and resets an invalid cursor with a status', async () => {
    const cursorDate = '2026-08-01T00:00:00.000Z'
    await WeeklyReportsPage({
      searchParams: Promise.resolve({ venue: 'venue-1', cursorDate, cursorId: 'report-2' }),
    })
    expect(mocks.listReports).toHaveBeenLastCalledWith({
      venueId: 'venue-1',
      cursor: { weekStart: new Date(cursorDate), id: 'report-2' },
    })

    render(
      await WeeklyReportsPage({
        searchParams: Promise.resolve({ venue: 'venue-1', cursorDate: 'invalid' }),
      }),
    )
    expect(mocks.listReports).toHaveBeenLastCalledWith({ venueId: 'venue-1' })
    expect(screen.getByRole('status').textContent).toContain('newest reports are shown')
  })

  it('renders only published projections, preserves venue in links, and passes axe', async () => {
    mocks.listReports.mockResolvedValueOnce({
      items: [
        {
          id: 'report-1',
          title: 'Week in review',
          weekStart: new Date('2026-07-20T12:00:00.000Z'),
          weekEnd: new Date('2026-07-26T12:00:00.000Z'),
          publishedAt: new Date('2026-07-27T12:00:00.000Z'),
        },
      ],
      nextCursor: { weekStart: new Date('2026-07-20T12:00:00.000Z'), id: 'report-1' },
    })

    const { container } = render(
      await WeeklyReportsPage({ searchParams: Promise.resolve({ venue: 'venue-2' }) }),
    )

    expect(screen.getByRole('link', { name: 'Read report' }).getAttribute('href')).toBe(
      '/weekly-reports/report-1?venue=venue-2',
    )
    expect(screen.getByRole('link', { name: 'Older reports' }).getAttribute('href')).toContain(
      'venue=venue-2',
    )
    document.documentElement.lang = 'en'
    document.title = 'Weekly reports'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations).toEqual([])
  })
})
