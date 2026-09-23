import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getPublicVenue: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))

vi.mock('../../../lib/public-venue', () => ({ getPublicVenue: mocks.getPublicVenue }))
vi.mock('next/navigation', () => ({
  notFound: mocks.notFound,
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock('../../../components/VenueChatExperience', () => ({
  VenueChatExperience: ({
    venueSlug,
    presentation,
    initialDraft,
    entrySource,
    initialEntryPlaceId,
    initialVenue,
  }: Record<string, string> & { initialVenue: { slug: string; venue: { id: string } } }) => (
    <div>{`${presentation}:${venueSlug}:${entrySource}:${initialEntryPlaceId}:${initialDraft}:${initialVenue.slug}:${initialVenue.venue.id}`}</div>
  ),
}))

import VenueChatPage from './page'

describe('standalone venue chat route', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.getPublicVenue.mockResolvedValue({ id: 'venue-1' })
    vi.stubGlobal('React', React)
  })

  it('renders the server-admitted venue in the shared standalone experience', async () => {
    const result = await VenueChatPage({
      params: Promise.resolve({ venueSlug: 'museum' }),
      searchParams: Promise.resolve({
        entry: 'guide-item',
        source: 'qr',
        item: 'tide-clock-2',
        prompt: 'Tell me about the Tide Clock.',
      }),
    })
    render(result)

    expect(
      screen.getByText(
        'standalone:museum:qr:tide-clock-2:Tell me about the Tide Clock.:museum:venue-1',
      ),
    ).toBeTruthy()
    expect(mocks.getPublicVenue).toHaveBeenCalledWith('museum')
  })

  it('keeps a failed public admission out of the chat experience', async () => {
    mocks.getPublicVenue.mockRejectedValueOnce({ code: 'SERVICE_UNAVAILABLE' })
    const result = await VenueChatPage({
      params: Promise.resolve({ venueSlug: 'museum' }),
      searchParams: Promise.resolve({}),
    })
    render(result)
    expect(screen.getByRole('heading', { name: 'Guide temporarily unavailable' })).toBeTruthy()
    expect(screen.queryByText(/standalone:museum/u)).toBeNull()
  })
})
