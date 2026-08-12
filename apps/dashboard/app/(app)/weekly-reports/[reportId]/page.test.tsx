/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  getReport: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('../../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    analytics: { getPublishedWeeklyReport: mocks.getReport },
  })),
}))

import WeeklyReportDetailPage from './page'

describe('WeeklyReportDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getReport.mockResolvedValue({
      id: 'report-1',
      title: 'Week in review',
      weekStart: new Date('2026-07-20T12:00:00.000Z'),
      weekEnd: new Date('2026-07-26T12:00:00.000Z'),
      publishedAt: new Date('2026-07-27T12:00:00.000Z'),
      content: '## Summary\nVisitors found the west entrance.',
    })
  })

  afterEach(() => cleanup())

  it('requires exact venue context before reading a report', async () => {
    await expect(
      WeeklyReportDetailPage({
        params: Promise.resolve({ reportId: 'report-1' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
    expect(mocks.getReport).not.toHaveBeenCalled()
  })

  it('reads the exact venue/report pair and retains venue context in the archive link', async () => {
    const element = await WeeklyReportDetailPage({
      params: Promise.resolve({ reportId: 'report-1' }),
      searchParams: Promise.resolve({ venue: 'venue-2' }),
    })
    render(element)

    expect(mocks.getReport).toHaveBeenCalledWith({ venueId: 'venue-2', reportId: 'report-1' })
    expect(screen.getByRole('link', { name: 'Back to reports' }).getAttribute('href')).toBe(
      '/weekly-reports?venue=venue-2',
    )
    expect(screen.getByRole('heading', { name: 'Week in review' })).toBeTruthy()
  })

  it('maps only NOT_FOUND to the missing route and rethrows unknown failures', async () => {
    mocks.getReport.mockRejectedValueOnce({ code: 'NOT_FOUND' })
    await expect(
      WeeklyReportDetailPage({
        params: Promise.resolve({ reportId: 'missing' }),
        searchParams: Promise.resolve({ venue: 'venue-2' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')

    const failure = new Error('private database detail')
    mocks.getReport.mockRejectedValueOnce(failure)
    await expect(
      WeeklyReportDetailPage({
        params: Promise.resolve({ reportId: 'report-1' }),
        searchParams: Promise.resolve({ venue: 'venue-2' }),
      }),
    ).rejects.toBe(failure)
  })
})
