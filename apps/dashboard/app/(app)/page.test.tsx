import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  lifecycleList: vi.fn(),
  listRequests: vi.fn(),
  billingOverview: vi.fn(),
  auth: vi.fn(),
}))
vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: vi.fn() })) }))
vi.mock('next/navigation', () => ({
  redirect: (location: string) => {
    throw new Error(`redirect:${location}`)
  },
}))
vi.mock('../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    portal: { getVenueLifecycles: mocks.lifecycleList },
    support: { listRequests: mocks.listRequests },
    billing: { overview: mocks.billingOverview },
  })),
}))

import DashboardIndexPage from './page'

describe('dashboard home', () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
    mocks.auth.mockResolvedValue({ sessionClaims: {}, orgRole: 'org:member' })
    mocks.venueList.mockResolvedValue([
      { id: 'venue_alpha', name: 'Science Museum', slug: 'science' },
      { id: 'venue_beta', name: 'History Center', slug: 'history' },
    ])
    mocks.lifecycleList.mockResolvedValue([
      {
        venueId: 'venue_alpha',
        lifecycle: { state: 'COLLECTING', clientAction: 'CONTINUE_INTAKE' },
        clientPreview: { state: 'UNAVAILABLE', id: null },
      },
      {
        venueId: 'venue_beta',
        lifecycle: { state: 'LIVE', clientAction: 'NONE' },
        clientPreview: { state: 'UNAVAILABLE', id: null },
      },
    ])
    mocks.listRequests.mockResolvedValue({
      items: [
        {
          id: 'request_1',
          subject: 'Add fall hours',
          status: 'WAITING_FOR_CLIENT',
          missingInformation: ['Opening hours'],
          canReply: true,
          clientActivityAt: new Date('2026-09-24T15:00:00.000Z'),
          statusChangedAt: new Date('2026-09-24T15:00:00.000Z'),
        },
      ],
      nextCursor: null,
    })
    mocks.billingOverview.mockResolvedValue({ enabled: true })
  })

  it('builds every Home job from the explicitly selected second venue', async () => {
    const element = await DashboardIndexPage({
      searchParams: Promise.resolve({ venue: 'venue_beta' }),
    })

    expect(mocks.listRequests).toHaveBeenCalledWith({ venueId: 'venue_beta' })
    expect(element.props.venue).toEqual({ id: 'venue_beta', name: 'History Center' })
    expect(element.props.guide).toEqual({
      kind: 'published',
      url: 'https://guide.example.com/history/chat',
    })
    expect(element.props.requests).toEqual([
      expect.objectContaining({
        needsYou: true,
        href: '/support?venue=venue_beta&request=request_1',
      }),
    ])
    // Staff can send files; links and notes need a manager. Payment stays off without the switch.
    expect(element.props.canSendLinksAndNotes).toBe(false)
    expect(element.props.payment).toEqual({ available: false, canPay: false })
    expect(mocks.billingOverview).not.toHaveBeenCalled()
  })

  it('never shows a visitor link before the guide is published', async () => {
    mocks.auth.mockResolvedValue({ sessionClaims: {}, orgRole: 'org:admin' })
    vi.stubEnv('STRIPE_BILLING_UI_ENABLED', 'true')
    const element = await DashboardIndexPage({ searchParams: Promise.resolve({}) })

    expect(element.props.venue.id).toBe('venue_alpha')
    expect(element.props.guide).toEqual({ kind: 'building' })
    expect(element.props.requests[0]).toMatchObject({
      id: 'lifecycle-setup',
      href: '/venues/venue_alpha/onboarding',
    })
    expect(element.props.canSendLinksAndNotes).toBe(true)
    expect(element.props.payment).toEqual({ available: true, canPay: true })
  })

  it('sends a tenant without venues to setup', async () => {
    mocks.venueList.mockResolvedValue([])
    await expect(DashboardIndexPage({ searchParams: Promise.resolve({}) })).rejects.toThrow(
      'redirect:/onboarding/setup',
    )
  })
})
