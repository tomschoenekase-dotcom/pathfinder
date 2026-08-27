import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBySlug: vi.fn(),
  mediaBySlug: vi.fn(),
  notFound: vi.fn(),
}))

vi.mock('@pathfinder/api', () => ({
  createTRPCContext: vi.fn(async () => ({})),
  appRouter: {
    createCaller: () => ({
      venue: {
        getBySlug: mocks.getBySlug,
        mediaBySlug: mocks.mediaBySlug,
      },
    }),
  },
}))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('../../components/VenueArrival', () => ({
  VenueArrival: ({ media, mediaStatus }: { media: unknown[]; mediaStatus: string }) => (
    <div>{`${mediaStatus}:${media.length}`}</div>
  ),
}))
vi.mock('../../components/VenueTemporarilyUnavailable', () => ({
  VenueTemporarilyUnavailable: () => <div>Temporarily unavailable</div>,
}))

import VenueLandingPage from './page'

const venue = {
  id: 'venue-1',
  name: 'Museum',
  description: null,
  category: 'museum',
  defaultCenterLat: null,
  defaultCenterLng: null,
}

describe('venue landing media boundary', () => {
  beforeEach(() => {
    cleanup()
    vi.stubGlobal('React', React)
    mocks.getBySlug.mockResolvedValue(venue)
    mocks.mediaBySlug.mockResolvedValue({ items: [] })
  })

  afterEach(() => vi.clearAllMocks())

  it('passes governed media through to the visitor arrival surface', async () => {
    mocks.mediaBySlug.mockResolvedValueOnce({ items: [{ derivativeId: 'media-1' }] })

    render(await VenueLandingPage({ params: Promise.resolve({ venueSlug: 'museum' }) }))

    expect(screen.getByText('ready:1')).toBeTruthy()
    expect(mocks.mediaBySlug).toHaveBeenCalledWith({ slug: 'museum' })
  })

  it('keeps the guide available when only the media listing fails', async () => {
    mocks.mediaBySlug.mockRejectedValueOnce(new Error('media unavailable'))

    render(await VenueLandingPage({ params: Promise.resolve({ venueSlug: 'museum' }) }))

    expect(screen.getByText('unavailable:0')).toBeTruthy()
  })
})
