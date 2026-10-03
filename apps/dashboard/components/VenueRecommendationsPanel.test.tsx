/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  measurement: vi.fn(),
  upsertPolicy: vi.fn(),
  upsertItem: vi.fn(),
  setPriority: vi.fn(),
  archive: vi.fn(),
}))

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => ({
    venueRecommendation: {
      getOverview: { query: mocks.overview },
      getMeasurement: { query: mocks.measurement },
      upsertPolicy: { mutate: mocks.upsertPolicy },
      upsertItem: { mutate: mocks.upsertItem },
      setItemPriority: { mutate: mocks.setPriority },
      archiveItem: { mutate: mocks.archive },
    },
  }),
}))

import { VenueRecommendationsPanel } from './VenueRecommendationsPanel'

const venues = [{ id: 'venue-1', name: 'Garden Museum' }]

beforeEach(() => {
  mocks.overview.mockResolvedValue({
    policy: null,
    items: [
      {
        id: 'item-1',
        version: 2,
        stableKey: 'lemonade',
        name: 'Fresh Lemonade',
        category: 'cold_drink',
        priceMinor: 500,
        currency: 'USD',
        availability: 'AVAILABLE',
        lastVerifiedAt: '2026-07-10T00:00:00.000Z',
        archivedAt: null,
        commercialPriority: 'NORMAL',
      },
    ],
  })
  mocks.measurement.mockResolvedValue({
    windowDays: 30,
    truncated: false,
    counts: { eligibleSessions: 12, shownSessions: 5, shownEvents: 5 },
    note: 'Sales attribution is unavailable: no revenue is reported.',
    clickDefinition: 'A click is an existing public click.',
  })
  mocks.upsertPolicy.mockResolvedValue({})
  mocks.setPriority.mockResolvedValue({})
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('VenueRecommendationsPanel', () => {
  it('does not load or show controls for non-managers', () => {
    render(<VenueRecommendationsPanel venues={venues} initialVenueId="venue-1" canManage={false} />)
    expect(mocks.overview).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('Recommendation policy')).toBeNull()
  })

  it('shows the capability as off when no policy exists and reports raw counts with the attribution note', async () => {
    render(<VenueRecommendationsPanel venues={venues} initialVenueId="venue-1" canManage />)
    expect(await screen.findByText(/not set up: off/u)).toBeTruthy()
    expect(await screen.findByText('Sessions with an eligible item')).toBeTruthy()
    expect(screen.getByText('12')).toBeTruthy()
    expect(screen.getByText(/Sales attribution is unavailable/u)).toBeTruthy()
    expect(mocks.overview).toHaveBeenCalledWith(
      { venueId: 'venue-1' },
      expect.objectContaining({ signal: expect.anything() }),
    )
  })

  it('saves the policy with the proposed cap of one and bounded tie-break', async () => {
    render(<VenueRecommendationsPanel venues={venues} initialVenueId="venue-1" canManage />)
    await screen.findByText(/not set up: off/u)
    fireEvent.click(screen.getByLabelText(/Turn featured items on/u))
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }))
    await waitFor(() => expect(mocks.upsertPolicy).toHaveBeenCalledTimes(1))
    expect(mocks.upsertPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: 'venue-1',
        enabled: true,
        maxBoost: 3,
        maxUnsolicitedPerSession: 1,
      }),
    )
  })

  it('changes the private priority through the manager procedure', async () => {
    render(<VenueRecommendationsPanel venues={venues} initialVenueId="venue-1" canManage />)
    const select = await screen.findByDisplayValue('Normal')
    fireEvent.change(select, { target: { value: 'HIGH' } })
    await waitFor(() =>
      expect(mocks.setPriority).toHaveBeenCalledWith({
        venueId: 'venue-1',
        itemId: 'item-1',
        priority: 'HIGH',
      }),
    )
  })
})
