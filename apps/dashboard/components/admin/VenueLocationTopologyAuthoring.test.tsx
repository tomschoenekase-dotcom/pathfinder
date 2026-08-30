/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  createFloor: vi.fn(),
  updateFloor: vi.fn(),
  floorAvailability: vi.fn(),
  createConnection: vi.fn(),
  updateConnection: vi.fn(),
  connectionAvailability: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createVenueFloorDraft: { mutate: mocks.createFloor },
      updateVenueFloorDraft: { mutate: mocks.updateFloor },
      setVenueFloorAvailability: { mutate: mocks.floorAvailability },
      createVenueLocationConnectionDraft: { mutate: mocks.createConnection },
      updateVenueLocationConnectionDraft: { mutate: mocks.updateConnection },
      setVenueLocationConnectionAvailability: { mutate: mocks.connectionAvailability },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { VenueLocationTopologyAuthoring } from './VenueLocationTopologyAuthoring'

const revision = new Date('2026-08-23T20:00:00.000Z')
const locations = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'East entrance',
    stableKey: 'east-entrance',
    isActive: true,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    displayName: 'Main gallery',
    stableKey: 'main-gallery',
    isActive: true,
  },
]
const floor = {
  id: '33333333-3333-4333-8333-333333333333',
  stableKey: 'ground-floor',
  name: 'Ground floor',
  level: 0,
  sortOrder: 0,
  mapImageUrl: null,
  isActive: false,
  updatedAt: revision,
}
const connection = {
  id: '44444444-4444-4444-8444-444444444444',
  fromLocationId: locations[0]!.id,
  toLocationId: locations[1]!.id,
  kind: 'WALKWAY',
  bidirectional: true,
  accessible: true,
  directions: 'Follow the level marked path.',
  isActive: false,
  verifiedAt: revision,
  updatedAt: revision,
}

describe('VenueLocationTopologyAuthoring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', { randomUUID: () => '55555555-5555-4555-8555-555555555555' })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders honest empty states without implying route computation', () => {
    render(
      <VenueLocationTopologyAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        floors={[]}
        locations={[]}
        connections={[]}
      />,
    )
    expect(screen.getByText(/does not compute routes/)).toBeTruthy()
    expect(screen.getByText(/Create at least two anchors/)).toBeTruthy()
    expect(screen.getByText(/A venue without floors can still use standalone anchors/)).toBeTruthy()
  })

  it('creates inactive floor and connection drafts from mobile-sized forms', async () => {
    mocks.createFloor.mockResolvedValue({ replayed: false })
    mocks.createConnection.mockResolvedValue({ replayed: false })
    render(
      <VenueLocationTopologyAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        floors={[]}
        locations={locations}
        connections={[]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ground floor' } })
    fireEvent.change(screen.getByLabelText('Floor stable key'), {
      target: { value: 'ground-floor' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save floor draft' }))
    await waitFor(() =>
      expect(mocks.createFloor).toHaveBeenCalledWith(
        expect.objectContaining({ stableKey: 'ground-floor', level: null, sortOrder: 0 }),
      ),
    )

    fireEvent.change(screen.getByLabelText('From anchor'), { target: { value: locations[0]!.id } })
    fireEvent.change(screen.getByLabelText('To anchor'), { target: { value: locations[1]!.id } })
    fireEvent.click(screen.getByLabelText('Accessible route'))
    fireEvent.click(screen.getByRole('button', { name: 'Save connection draft' }))
    await waitFor(() =>
      expect(mocks.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          fromLocationId: locations[0]!.id,
          toLocationId: locations[1]!.id,
          bidirectional: true,
          accessible: true,
        }),
      ),
    )
  })

  it('keeps floor and connection activation reasoned and revision-bound', async () => {
    mocks.floorAvailability.mockResolvedValue({ replayed: false })
    mocks.connectionAvailability.mockResolvedValue({ replayed: false })
    render(
      <VenueLocationTopologyAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        floors={[floor]}
        locations={locations}
        connections={[connection]}
      />,
    )
    const floorCard = screen.getByText('Ground floor').closest('article')!
    fireEvent.change(within(floorCard).getByLabelText('Review reason'), {
      target: { value: 'Matched the current public floor map.' },
    })
    fireEvent.click(within(floorCard).getByRole('button', { name: 'Activate floor' }))
    await waitFor(() =>
      expect(mocks.floorAvailability).toHaveBeenCalledWith(
        expect.objectContaining({
          floorId: floor.id,
          expectedUpdatedAt: revision,
          active: true,
        }),
      ),
    )

    const connectionCard = screen.getByText(/East entrance → Main gallery/).closest('article')!
    fireEvent.change(within(connectionCard).getByLabelText('Review reason'), {
      target: { value: 'Both active anchors and the path were verified.' },
    })
    fireEvent.click(
      within(connectionCard).getByRole('button', { name: 'Activate verified connection' }),
    )
    await waitFor(() =>
      expect(mocks.connectionAvailability).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionId: connection.id,
          expectedUpdatedAt: revision,
          active: true,
        }),
      ),
    )
  })
})
