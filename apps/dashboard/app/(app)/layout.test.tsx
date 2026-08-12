import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cookies: vi.fn(),
  availability: vi.fn(),
  getSettings: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('next/headers', () => ({ cookies: mocks.cookies }))
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Error(`redirect:${location}`)
  },
}))
vi.mock('../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    analytics: { getWeeklyReportAvailability: mocks.availability },
    tenant: { getSettings: mocks.getSettings },
  })),
}))
vi.mock('../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => children,
}))

import DashboardAppLayout from './layout'

describe('DashboardAppLayout report availability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({
      userId: 'user-1',
      orgId: 'tenant-1',
      sessionClaims: {},
    })
    mocks.cookies.mockResolvedValue({ get: vi.fn(() => undefined) })
    mocks.availability.mockResolvedValue({ enabledVenueIds: [] })
  })

  it('enables report navigation when at least one authorized venue is enabled', async () => {
    mocks.availability.mockResolvedValueOnce({ enabledVenueIds: ['venue-2'] })

    const result = await DashboardAppLayout({ children: <div>content</div> })

    expect(mocks.availability).toHaveBeenCalledWith()
    expect(result.props.children.props.weeklyReportsAvailable).toBe(true)
  })

  it('keeps report navigation hidden when no venue is enabled or availability fails', async () => {
    const disabled = await DashboardAppLayout({ children: <div>content</div> })
    expect(disabled.props.children.props.weeklyReportsAvailable).toBe(false)

    mocks.availability.mockRejectedValueOnce(new Error('private provider detail'))
    const unavailable = await DashboardAppLayout({ children: <div>content</div> })
    expect(unavailable.props.children.props.weeklyReportsAvailable).toBe(false)
  })
})
