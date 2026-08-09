/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  getAiConfig: vi.fn(),
  listPlaces: vi.fn(),
}))

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn().mockResolvedValue({ orgRole: 'org:member', sessionClaims: {} }),
}))
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))
vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={String(href)} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('../../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn().mockResolvedValue({
    venue: { getById: mocks.getById, getAiConfig: mocks.getAiConfig },
    place: { list: mocks.listPlaces },
  }),
}))
vi.mock('../../../../components/ContentHistoryPanel', () => ({ ContentHistoryPanel: () => null }))
vi.mock('../../../../components/DeletedContentHistoryPanel', () => ({
  DeletedContentHistoryPanel: () => null,
}))
vi.mock('../../../../components/DeletedVenueHistoryPanel', () => ({
  DeletedVenueHistoryPanel: () => null,
}))
vi.mock('../../../../components/VenueAvailabilityControl', () => ({
  VenueAvailabilityControl: () => null,
}))

import VenueDetailPage from './page'

const baseVenue = {
  id: 'venue-1',
  slug: 'museum',
  name: 'Museum',
  category: 'museum',
  description: null,
  guideMode: 'location_aware',
  defaultCenterLat: 41.5,
  defaultCenterLng: -81.7,
  isActive: true,
  updatedAt: new Date('2026-08-09T00:00:00.000Z'),
  _count: { places: 1, knowledgeEntries: 0 },
}

const basePlace = {
  id: 'place-1',
  venueId: 'venue-1',
  name: 'Main Gallery',
  areaName: 'First floor',
  type: 'EXHIBIT',
  isActive: true,
  lat: 41.51,
  lng: -81.71,
}

describe('venue detail sharing and mode presentation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', '')
    mocks.getById.mockResolvedValue(baseVenue)
    mocks.getAiConfig.mockResolvedValue({
      aiTone: 'FRIENDLY',
      aiFeaturedPlaceId: null,
      aiGuideNotes: null,
    })
    mocks.listPlaces.mockResolvedValue([basePlace])
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllEnvs()
  })

  it('shows missing public configuration instead of hiding access or inventing a URL', async () => {
    render(
      await VenueDetailPage({
        params: Promise.resolve({ venueId: 'venue-1' }),
        searchParams: Promise.resolve({ onboarded: '1' }),
      }),
    )

    expect(screen.getByText('Sharing unavailable')).toBeTruthy()
    expect(document.body.textContent).not.toContain('your-domain.com')
    expect(screen.queryByRole('link', { name: 'Open guest chat' })).toBeNull()
    expect(screen.getByText(/review and test the guest experience before sharing/i)).toBeTruthy()
  })

  it('encodes the venue slug and exposes review controls for a valid public origin', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com/')
    mocks.getById.mockResolvedValue({ ...baseVenue, slug: 'museum west' })

    render(
      await VenueDetailPage({
        params: Promise.resolve({ venueId: 'venue-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(screen.getByRole('link', { name: 'Open guest chat' }).getAttribute('href')).toBe(
      'https://guide.example.com/museum%20west/chat',
    )
    expect(screen.getByRole('button', { name: 'Copy guest chat URL' })).toBeTruthy()
  })

  it('removes location-only facts and table columns for a non-location guide', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
    mocks.getById.mockResolvedValue({
      ...baseVenue,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
    })

    render(
      await VenueDetailPage({
        params: Promise.resolve({ venueId: 'venue-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(screen.getByText('Guide without visitor location')).toBeTruthy()
    expect(screen.queryByText('Center latitude')).toBeNull()
    expect(screen.queryByText('Center longitude')).toBeNull()
    expect(screen.queryByRole('columnheader', { name: 'Coordinates' })).toBeNull()
    expect(document.body.textContent).not.toContain('41.51000, -81.71000')
  })

  it('hands a Knowledge-first venue to a content-neutral ready review', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
    mocks.getById.mockResolvedValue({
      ...baseVenue,
      defaultCenterLat: null,
      defaultCenterLng: null,
      _count: { places: 0, knowledgeEntries: 1 },
    })
    mocks.listPlaces.mockResolvedValue([])

    render(
      await VenueDetailPage({
        params: Promise.resolve({ venueId: 'venue-1' }),
        searchParams: Promise.resolve({ onboarded: '1' }),
      }),
    )

    expect(screen.getByText('Review link available')).toBeTruthy()
    expect(screen.queryByText(/add active public content/i)).toBeNull()
    expect(screen.getByText('Enabled Knowledge entries').nextElementSibling?.textContent).toBe('1')
    expect(screen.getAllByRole('link', { name: 'Add guide item' })).toHaveLength(2)
    expect(screen.getByRole('link', { name: 'Manage Knowledge' })).toBeTruthy()
    expect(screen.getByText(/knowledge can answer general questions/i)).toBeTruthy()
  })

  it('keeps a venue with no active Place or enabled Knowledge in preview', async () => {
    vi.stubEnv('NEXT_PUBLIC_WEB_URL', 'https://guide.example.com')
    mocks.getById.mockResolvedValue({
      ...baseVenue,
      guideMode: 'non_location',
      defaultCenterLat: null,
      defaultCenterLng: null,
      _count: { places: 0, knowledgeEntries: 0 },
    })
    mocks.listPlaces.mockResolvedValue([])

    render(
      await VenueDetailPage({
        params: Promise.resolve({ venueId: 'venue-1' }),
        searchParams: Promise.resolve({}),
      }),
    )

    expect(screen.getByText('Preview only')).toBeTruthy()
    expect(
      screen.getByText('Add active public content: a guide item or Knowledge entry.'),
    ).toBeTruthy()
    expect(screen.queryByText('Review link available')).toBeNull()
  })
})
