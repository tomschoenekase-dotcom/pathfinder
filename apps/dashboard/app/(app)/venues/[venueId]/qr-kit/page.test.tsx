import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  lifecycleList: vi.fn(),
  placeList: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('../../../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    portal: { getVenueLifecycles: mocks.lifecycleList },
    place: { list: mocks.placeList },
  })),
}))

import VenueQrKitPage from './page'

const venue = { id: 'venue_1', name: 'Museum', slug: 'museum' }

describe('client QR kit route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_WEB_URL = 'https://guide.example.com'
    mocks.venueList.mockResolvedValue([venue])
    mocks.lifecycleList.mockResolvedValue([{ venueId: venue.id, lifecycle: { state: 'LIVE' } }])
    mocks.placeList.mockResolvedValue([])
  })

  it('passes only active public item identity into the client QR component', async () => {
    mocks.placeList.mockResolvedValue([
      {
        id: 'public_1',
        name: 'Tide Clock',
        updatedAt: new Date('2026-09-08T12:00:00.000Z'),
        isActive: true,
        visibility: 'PUBLIC',
        longDescription: 'private server-side metadata',
      },
      {
        id: 'staff_1',
        name: 'Staff entrance',
        updatedAt: new Date(),
        isActive: true,
        visibility: 'SECOND_LAYER',
      },
      {
        id: 'retired_1',
        name: 'Old exhibit',
        updatedAt: new Date(),
        isActive: false,
        visibility: 'PUBLIC',
      },
    ])

    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    const kit = result.props.children[1]
    expect(mocks.placeList).toHaveBeenCalledWith({ venueId: venue.id })
    expect(kit.props).toMatchObject({
      audience: 'client',
      venueName: 'Museum',
      guestChatUrl: 'https://guide.example.com/museum/chat',
      guideItems: [{ id: 'public_1', name: 'Tide Clock', updatedAt: '2026-09-08T12:00:00.000Z' }],
    })
    expect(JSON.stringify(kit.props)).not.toContain('private server-side metadata')
  })

  it.each(['READY', 'LIVE'])('allows only an existing %s venue lifecycle', async (state) => {
    mocks.lifecycleList.mockResolvedValue([{ venueId: venue.id, lifecycle: { state } }])
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.children[1].props.guestChatUrl).toContain('/museum/chat')
  })

  it.each(['SETUP_REQUESTED', 'COLLECTING', 'CLIENT_PREVIEW', 'PAUSED'])(
    'does not read places or generate QR content in %s state',
    async (state) => {
      mocks.lifecycleList.mockResolvedValue([{ venueId: venue.id, lifecycle: { state } }])
      const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
      expect(mocks.placeList).not.toHaveBeenCalled()
      expect(result.type).toBe('section')
      expect(result.props.children).toEqual(expect.any(Array))
    },
  )

  it('fails closed for a venue outside the authenticated tenant projection', async () => {
    await expect(
      VenueQrKitPage({ params: Promise.resolve({ venueId: 'foreign_venue' }) }),
    ).rejects.toThrow('NOT_FOUND')
    expect(mocks.placeList).not.toHaveBeenCalled()
  })

  it('fails closed when the selected venue has no lifecycle row', async () => {
    mocks.lifecycleList.mockResolvedValue([])
    await expect(
      VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) }),
    ).rejects.toThrow('NOT_FOUND')
    expect(mocks.placeList).not.toHaveBeenCalled()
  })

  it('uses the exact selected venue when the tenant has more than one', async () => {
    mocks.venueList.mockResolvedValue([
      { id: 'venue_other', name: 'Other venue', slug: 'other' },
      venue,
    ])
    mocks.lifecycleList.mockResolvedValue([
      { venueId: 'venue_other', lifecycle: { state: 'PAUSED' } },
      { venueId: venue.id, lifecycle: { state: 'LIVE' } },
    ])
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.children[0].props.href).toBe('/?venue=venue_1')
    expect(result.props.children[1].props.guestChatUrl).toBe(
      'https://guide.example.com/museum/chat',
    )
  })

  it('renders no code when the public origin is invalid', async () => {
    process.env.NEXT_PUBLIC_WEB_URL = 'http://public.example.com'
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(mocks.placeList).not.toHaveBeenCalled()
    expect(result.type).toBe('section')
  })
})
