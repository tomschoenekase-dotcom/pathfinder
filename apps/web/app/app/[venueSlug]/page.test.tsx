import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  getPublicVenue: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND')
  }),
}))
vi.mock('@pathfinder/db', () => ({ resolveCachedVenueDistribution: mocks.resolve }))
vi.mock('@pathfinder/ui/theme', () => ({ getChatPalette: () => ({ bg: '#f1f5f9' }) }))
vi.mock('next/navigation', () => ({ notFound: mocks.notFound }))
vi.mock('../../../lib/public-venue', () => ({ getPublicVenue: mocks.getPublicVenue }))
vi.mock('../../../components/VenueChatExperience', () => ({
  VenueChatExperience: (props: Record<string, unknown>) => (
    <pre data-testid="experience">{JSON.stringify(props)}</pre>
  ),
}))
vi.mock('../../../components/VenueTemporarilyUnavailable', () => ({
  VenueTemporarilyUnavailable: () => <div>paused</div>,
}))
vi.mock('../../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import AppVenuePage from './page'

const venue = { id: 'venue-1', name: 'Museum', chatTheme: 'forest' }
const distribution = {
  venueId: 'venue-1',
  tenantId: 'tenant-1',
  venueActive: true,
  website: { effective: true, reason: null, origins: ['https://venue.example'] },
  app: { effective: true, reason: null },
  revision: 1,
}

describe('canonical app route', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(distribution)
    mocks.getPublicVenue.mockResolvedValue(venue)
    vi.stubGlobal('React', React)
  })

  it.each([
    [{}, 'full'],
    [{ header: 'compact' }, 'compact'],
    [{ header: 'none', ask: 'Find the gallery', place: 'public-1' }, 'none'],
    [{ header: 'compact', source: 'app' }, 'full'],
  ])('renders SSR venue and bounded app chrome for query %#', async (searchParams, appHeader) => {
    render(
      await AppVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve(searchParams),
      }),
    )
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props).toMatchObject({
      venueSlug: 'museum',
      initialVenue: { slug: 'museum', venue },
      presentation: 'webview',
      appHeader,
      accessSurface: 'app',
    })
    if ('ask' in searchParams) {
      expect(props.initialDraft).toBe('Find the gallery')
      expect(props.initialEntryPlaceId).toBe('public-1')
    }
  })

  it('rejects malformed start input without changing the app access gate', async () => {
    render(
      await AppVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ ask: 'a'.repeat(201), place: ['one', 'two'] }),
      }),
    )
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props.initialDraft).toBe('')
    expect(props.initialEntryPlaceId).toBeUndefined()
    expect(mocks.resolve).toHaveBeenCalledWith({ venueSlug: 'museum' })
  })
})
