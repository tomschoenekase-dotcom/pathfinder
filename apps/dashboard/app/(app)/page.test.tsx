import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  updateList: vi.fn(),
  lifecycleList: vi.fn(),
  taskEvidence: vi.fn(),
  secondLayer: vi.fn(),
  visitorPulse: vi.fn(),
  auth: vi.fn(),
}))
vi.mock('@clerk/nextjs/server', () => ({ auth: mocks.auth }))
vi.mock('next/headers', () => ({ cookies: vi.fn(async () => ({ get: vi.fn() })) }))
vi.mock('../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList, getSecondLayer: mocks.secondLayer },
    operationalUpdate: { list: mocks.updateList },
    portal: {
      getVenueLifecycles: mocks.lifecycleList,
      getVenueTaskEvidence: mocks.taskEvidence,
      getVenueVisitorPulse: mocks.visitorPulse,
    },
  })),
}))

import DashboardIndexPage from './page'

describe('dashboard home venue selection', () => {
  afterEach(() => vi.unstubAllEnvs())

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
    mocks.auth.mockResolvedValue({ sessionClaims: {} })
    mocks.venueList.mockResolvedValue([
      { id: 'venue_alpha', name: 'Science Museum', slug: 'science' },
      { id: 'venue_beta', name: 'History Center', slug: 'history' },
    ])
    mocks.updateList.mockResolvedValue([])
    mocks.lifecycleList.mockResolvedValue([
      { venueId: 'venue_alpha', lifecycle: { state: 'COLLECTING' }, clientPreview: {} },
      { venueId: 'venue_beta', lifecycle: { state: 'LIVE' }, clientPreview: {} },
    ])
    mocks.taskEvidence.mockResolvedValue({
      missingInformation: [],
      additionalMissingRequest: false,
      hasSharedInformation: true,
      latestReport: null,
    })
    mocks.secondLayer.mockResolvedValue({
      secondLayerEnabled: false,
      secondLayerLabel: 'Staff',
      secondLayerAccessKey: null,
      slug: 'history',
      updatedAt: new Date('2026-09-08T12:00:00.000Z'),
    })
    mocks.visitorPulse.mockResolvedValue({ conversations: 2 })
  })

  it('drives lifecycle reads and client links from the explicitly selected second venue', async () => {
    const element = await DashboardIndexPage({
      searchParams: Promise.resolve({ venue: 'venue_beta' }),
    })

    expect(mocks.taskEvidence).toHaveBeenCalledWith({ venueId: 'venue_beta' })
    expect(mocks.secondLayer).toHaveBeenCalledWith({ venueId: 'venue_beta' })
    expect(mocks.visitorPulse).toHaveBeenCalledWith({ venueId: 'venue_beta' })
    expect(element.props.venue).toMatchObject({
      id: 'venue_beta',
      name: 'History Center',
      lifecycle: { state: 'LIVE' },
    })
    expect(element.props.chatUrl).toBe('https://guide.example.com/history/chat')
  })
})
