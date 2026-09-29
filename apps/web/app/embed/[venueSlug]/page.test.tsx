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
  VenueTemporarilyUnavailable: ({ showHomeLink }: { showHomeLink?: boolean }) => (
    <div>{`Temporarily unavailable:${String(showHomeLink)}`}</div>
  ),
}))
vi.mock('../../../components/WidgetReadySignal', () => ({
  WidgetReadySignal: ({ venueSlug }: { venueSlug: string }) => <div>{`ready:${venueSlug}`}</div>,
}))
vi.mock('../../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import EmbedVenuePage, { metadata } from './page'

const activeDistribution = {
  venueId: 'venue-1',
  tenantId: 'tenant-1',
  venueActive: true,
  website: { effective: true, reason: null, origins: ['https://venue.example'] },
  app: { effective: true, reason: null },
  revision: 1,
}
const venue = { id: 'venue-1', name: 'Museum', chatTheme: 'forest', chatAccentColor: null }

describe('distribution embed routes', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue(activeDistribution)
    mocks.getPublicVenue.mockResolvedValue(venue)
    vi.stubGlobal('React', React)
  })

  it('loads and server-renders the venue for the launcher presentation', async () => {
    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({}),
      }),
    )
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props).toMatchObject({
      venueSlug: 'museum',
      initialVenue: { slug: 'museum', venue },
      presentation: 'embed',
      accessSurface: 'website',
    })
    expect(screen.getByText('ready:museum')).toBeTruthy()
  })

  it('uses the app gate and identical app presentation for the hidden-chrome alias', async () => {
    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ chrome: 'hidden', ask: 'Find the map' }),
      }),
    )
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props).toMatchObject({
      presentation: 'webview',
      accessSurface: 'app',
      initialDraft: 'Find the map',
    })
    expect(props.bridgeOrigins).toBeUndefined()
    expect(screen.queryByText('ready:museum')).toBeNull()
  })

  it('passes bounded website start input and the resolver-owned origin list', async () => {
    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ ask: 'Where is the entrance?', place: 'public-1' }),
      }),
    )
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props).toMatchObject({
      presentation: 'embed',
      initialDraft: 'Where is the entrance?',
      initialEntryPlaceId: 'public-1',
      bridgeOrigins: ['https://venue.example'],
    })
  })

  it('fails closed when the effective website or app surface is unavailable', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...activeDistribution, website: { effective: false } })
    await expect(
      EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
    mocks.resolve.mockResolvedValueOnce({ ...activeDistribution, app: { effective: false } })
    await expect(
      EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({ chrome: 'hidden' }),
      }),
    ).rejects.toThrow('NEXT_NOT_FOUND')
  })

  it('preserves the paused venue state and the no-index boundary', async () => {
    mocks.resolve.mockResolvedValueOnce({ ...activeDistribution, venueActive: false })
    render(
      await EmbedVenuePage({
        params: Promise.resolve({ venueSlug: 'museum' }),
        searchParams: Promise.resolve({}),
      }),
    )
    expect(screen.getByText('Temporarily unavailable:false')).toBeTruthy()
    expect(metadata.robots).toEqual({ index: false, follow: false })
  })
})
