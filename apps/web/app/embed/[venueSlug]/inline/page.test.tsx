import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), getPublicVenue: vi.fn() }))
vi.mock('@pathfinder/db', () => ({ resolveCachedVenueDistribution: mocks.resolve }))
vi.mock('@pathfinder/ui/theme', () => ({ getChatPalette: () => ({ bg: '#f1f5f9' }) }))
vi.mock('../../../../lib/public-venue', () => ({ getPublicVenue: mocks.getPublicVenue }))
vi.mock('../../../../components/VenueChatExperience', () => ({
  VenueChatExperience: (props: Record<string, unknown>) => (
    <pre data-testid="experience">{JSON.stringify(props)}</pre>
  ),
}))
vi.mock('../../../../components/VenueTemporarilyUnavailable', () => ({
  VenueTemporarilyUnavailable: () => <div>paused</div>,
}))
vi.mock('../../../../components/WidgetReadySignal', () => ({
  WidgetReadySignal: ({ venueSlug }: { venueSlug: string }) => <div>{`ready:${venueSlug}`}</div>,
}))
vi.mock('../../../../lib/trpc', () => ({
  TRPCProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

import InlineVenuePage from './page'

describe('website inline route', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mocks.resolve.mockResolvedValue({
      venueId: 'venue-1',
      tenantId: 'tenant-1',
      venueActive: true,
      website: { effective: true, reason: null, origins: ['https://venue.example'] },
      app: { effective: false, reason: 'SURFACE_DISABLED' },
      revision: 1,
    })
    mocks.getPublicVenue.mockResolvedValue({ id: 'venue-1', name: 'Museum' })
    vi.stubGlobal('React', React)
  })

  it('renders the venue inline and sends the exact ready handshake', async () => {
    render(await InlineVenuePage({ params: Promise.resolve({ venueSlug: 'museum' }) }))
    const props = JSON.parse(screen.getByTestId('experience').textContent ?? '{}') as Record<
      string,
      unknown
    >
    expect(props).toMatchObject({
      venueSlug: 'museum',
      initialVenue: { slug: 'museum' },
      presentation: 'embed-inline',
      accessSurface: 'website',
    })
    expect(screen.getByText('ready:museum')).toBeTruthy()
  })
})
