import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  venueList: vi.fn(),
  lifecycleList: vi.fn(),
  launchAsset: vi.fn(),
  placeList: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND')
  }),
}))

vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('../../../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    venue: { list: mocks.venueList },
    portal: { getVenueLifecycles: mocks.lifecycleList, getVenueLaunchAsset: mocks.launchAsset },
    place: { list: mocks.placeList },
  })),
}))

import {
  isVenueQrKitAvailable,
  VenueQrKitAvailability,
} from '../../../../../components/VenueQrKitAvailability'
import VenueQrKitPage from './page'

const venue = { id: 'venue_1', name: 'Museum', slug: 'museum' }
const asset = {
  schema: 'torchiko.venue-launch-asset/1',
  tenantId: 'tenant_1',
  venueId: venue.id,
  release: { kind: 'LEGACY', id: 'legacy:venue_1', revisionSha256: 'a'.repeat(64) },
  publicUrl: 'https://guide.example.com/museum/chat?source=qr',
  filename: 'torchiko-museum-qr.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: 4,
  sha256: 'b'.repeat(64),
  contentBase64: 'PHN2Zz4=',
}

describe('client QR kit route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_WEB_URL = 'https://guide.example.com'
    mocks.venueList.mockResolvedValue([venue])
    mocks.lifecycleList.mockResolvedValue([
      { venueId: venue.id, lifecycle: { state: 'LIVE' }, release: { released: true } },
    ])
    mocks.placeList.mockResolvedValue([])
    mocks.launchAsset.mockResolvedValue(asset)
  })

  it('does not load or expose place-specific QR inputs', async () => {
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
    const kit = result
    expect(mocks.placeList).not.toHaveBeenCalled()
    expect(kit.props).toMatchObject({
      venueName: 'Museum',
      guestChatUrl: 'https://guide.example.com/museum/chat',
    })
    expect(kit.props).not.toHaveProperty('guideItems')
    expect(JSON.stringify(kit.props)).not.toContain('private server-side metadata')
  })

  it.each(['READY', 'LIVE'])('allows only an existing %s venue lifecycle', async (state) => {
    mocks.lifecycleList.mockResolvedValue([
      { venueId: venue.id, lifecycle: { state }, release: { released: true } },
    ])
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.guestChatUrl).toContain('/museum/chat')
  })

  it.each(['SETUP_REQUESTED', 'COLLECTING', 'CLIENT_PREVIEW', 'PAUSED', 'OFFBOARDING'])(
    'does not read places or generate QR content in %s state',
    async (state) => {
      mocks.lifecycleList.mockResolvedValue([
        { venueId: venue.id, lifecycle: { state }, release: { released: false } },
      ])
      const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
      expect(mocks.placeList).not.toHaveBeenCalled()
      expect(result.type).toBe(VenueQrKitAvailability)
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
      { venueId: 'venue_other', lifecycle: { state: 'PAUSED' }, release: { released: false } },
      { venueId: venue.id, lifecycle: { state: 'LIVE' }, release: { released: true } },
    ])
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.venueId).toBe('venue_1')
    expect(result.props.guestChatUrl).toBe('https://guide.example.com/museum/chat')
  })

  it('renders no code when the public origin is invalid', async () => {
    process.env.NEXT_PUBLIC_WEB_URL = 'http://public.example.com'
    mocks.launchAsset.mockResolvedValue(null)
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(mocks.placeList).not.toHaveBeenCalled()
    expect(result.type).toBe(VenueQrKitAvailability)
  })

  it('keeps the current released guide available while a newer draft is in revisions', async () => {
    mocks.lifecycleList.mockResolvedValue([
      { venueId: venue.id, lifecycle: { state: 'REVISIONS' }, release: { released: true } },
    ])
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.guestChatUrl).toBe('https://guide.example.com/museum/chat')
    expect(mocks.placeList).not.toHaveBeenCalled()
  })

  it('fails closed for revisions without a current release', async () => {
    mocks.lifecycleList.mockResolvedValue([
      { venueId: venue.id, lifecycle: { state: 'REVISIONS' }, release: { released: false } },
    ])
    mocks.launchAsset.mockResolvedValue(null)
    const result = await VenueQrKitPage({ params: Promise.resolve({ venueId: venue.id }) })
    expect(result.props.guestChatUrl).toBeNull()
    expect(mocks.placeList).not.toHaveBeenCalled()
  })
})

describe('VenueQrKitAvailability', () => {
  it('fails closed unless the lifecycle and validated URL are both available', () => {
    expect(isVenueQrKitAvailable('READY', 'https://guide.example.com/museum/chat', true)).toBe(true)
    expect(isVenueQrKitAvailable('LIVE', 'https://guide.example.com/museum/chat', true)).toBe(true)
    expect(isVenueQrKitAvailable('REVISIONS', 'https://guide.example.com/museum/chat', true)).toBe(
      true,
    )
    expect(isVenueQrKitAvailable('REVISIONS', 'https://guide.example.com/museum/chat', false)).toBe(
      false,
    )
    expect(isVenueQrKitAvailable('READY', 'https://guide.example.com/museum/chat', false)).toBe(
      false,
    )
    expect(isVenueQrKitAvailable('PAUSED', 'https://guide.example.com/museum/chat', true)).toBe(
      false,
    )
    expect(
      isVenueQrKitAvailable('OFFBOARDING', 'https://guide.example.com/museum/chat', true),
    ).toBe(false)
    expect(isVenueQrKitAvailable('UNKNOWN', 'https://guide.example.com/museum/chat', true)).toBe(
      false,
    )
    expect(isVenueQrKitAvailable('READY', null, true)).toBe(false)

    const unavailable = VenueQrKitAvailability({
      venueId: 'venue_1',
      venueName: 'Museum',
      lifecycleState: 'PAUSED',
      hasCurrentRelease: true,
      guestChatUrl: 'https://guide.example.com/museum/chat',
      generatedAt: '2026-09-08T00:00:00.000Z',
    })
    expect(unavailable.type).toBe('section')
    const childText = (node: React.ReactNode): string => {
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map(childText).join(' ')
      if (React.isValidElement<{ children?: React.ReactNode }>(node))
        return childText(node.props.children)
      return ''
    }
    expect(childText(unavailable)).toContain('QR code is not available yet')
  })
})
