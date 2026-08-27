import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocationRoutePlanner } from './LocationRoutePlanner'

const catalogQuery = vi.fn()
const routeQuery = vi.fn()
const client = {
  location: {
    catalog: { query: catalogQuery },
    route: { query: routeQuery },
  },
}

vi.mock('../lib/trpc', () => ({
  useTRPCClient: () => client,
}))

const locations = [
  {
    id: 'entrance-id',
    stableKey: 'entrance',
    kind: 'ENTRANCE',
    displayName: 'Main entrance',
    floor: { stableKey: 'ground', name: 'Ground floor', level: 0 },
  },
  {
    id: 'gallery-id',
    stableKey: 'gallery',
    kind: 'EXHIBIT',
    displayName: 'Sky gallery',
    floor: { stableKey: 'upper', name: 'Upper floor', level: 1 },
  },
]

describe('LocationRoutePlanner', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    catalogQuery.mockResolvedValue({ locations })
    routeQuery.mockResolvedValue({
      from: locations[0],
      to: locations[1],
      accessibleOnly: true,
      segmentCount: 1,
      describedSegmentCount: 1,
      guidanceConfidence: 'HIGH',
      hasEquivalentRoute: false,
      review: { status: 'VENUE_REVIEWED', reviewedAt: new Date('2026-08-19T12:00:00Z') },
      segments: [
        {
          connectionId: 'lift-1',
          kind: 'ELEVATOR',
          accessible: true,
          directions: 'Take the lift to the upper floor.',
          from: locations[0],
          to: locations[1],
        },
      ],
    })
  })

  it('loads reviewed destinations and renders mobile-friendly route steps', async () => {
    render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
      />,
    )

    const toggle = await screen.findByRole('button', { name: 'Plan a route' })
    fireEvent.click(toggle)
    expect(screen.getByLabelText('Start')).toBeTruthy()
    expect(screen.getByLabelText('Destination')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Use only connections marked accessible/i))
    fireEvent.click(screen.getByRole('button', { name: 'Find route' }))

    await screen.findByText('Take the lift to the upper floor.')
    expect(screen.getByText('Main entrance to Sky gallery')).toBeTruthy()
    expect(screen.getByText('Venue-reviewed route')).toBeTruthy()
    expect(routeQuery).toHaveBeenCalledWith({
      venueId: 'venue-1',
      anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
      fromLocationId: 'entrance-id',
      toLocationId: 'gallery-id',
      accessibleOnly: true,
    })
  })

  it('stays absent when the catalog is unavailable or not entitled', async () => {
    catalogQuery.mockRejectedValue(new Error('not found'))
    render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
      />,
    )

    await waitFor(() => {
      expect(catalogQuery).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('button', { name: 'Plan a route' })).toBeNull()
    })
  })

  it('explains when no reviewed accessible route exists', async () => {
    routeQuery.mockRejectedValue(new Error('not found'))
    render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Plan a route' }))
    fireEvent.click(screen.getByLabelText(/Use only connections marked accessible/i))
    fireEvent.click(screen.getByRole('button', { name: 'Find route' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No reviewed accessible route is available',
    )
  })

  it('localizes route controls and errors without translating venue-owned names', async () => {
    routeQuery.mockRejectedValue(new Error('not found'))
    render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
        language="Español"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Planificar una ruta' }))
    expect(screen.getByLabelText('Inicio')).toBeTruthy()
    expect(screen.getAllByText('Main entrance — Ground floor')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'Buscar ruta' }))
    expect((await screen.findByRole('alert')).textContent).toContain('No hay una ruta revisada')
  })

  it('localizes generated fallback directions while preserving venue-owned names', async () => {
    routeQuery.mockResolvedValue({
      from: locations[0],
      to: locations[1],
      accessibleOnly: false,
      segmentCount: 1,
      describedSegmentCount: 0,
      guidanceConfidence: 'LIMITED',
      hasEquivalentRoute: true,
      review: { status: 'VENUE_REVIEWED', reviewedAt: new Date('2026-08-19T12:00:00Z') },
      segments: [
        {
          connectionId: 'lift-1',
          kind: 'ELEVATOR',
          accessible: true,
          directions: null,
          from: locations[0],
          to: locations[1],
        },
      ],
    })
    render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
        language="日本語"
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'ルートを計画' }))
    fireEvent.click(screen.getByRole('button', { name: 'ルートを検索' }))
    expect(await screen.findByText('elevatorを通ってSky galleryへ進みます。')).toBeTruthy()
    expect(screen.getByText('施設確認済みのルート')).toBeTruthy()
    expect(screen.getByText(/一部の手順には目印を使った案内がありません/)).toBeTruthy()
    expect(screen.getByText(/別の確認済みルートもあります/)).toBeTruthy()
  })

  it('has no automated accessibility violations in the expanded route form', async () => {
    const { container } = render(
      <LocationRoutePlanner
        venueId="venue-1"
        anonymousToken="123e4567-e89b-42d3-a456-426614174000"
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Plan a route' }))
    document.documentElement.lang = 'en'
    document.title = 'Torchiko route planner accessibility contract'
    const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })
    expect(result.violations.map(({ id }) => id)).toEqual([])
  })
})
