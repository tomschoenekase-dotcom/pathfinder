/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  availability: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      createVenueLocationDraft: { mutate: mocks.create },
      updateVenueLocationDraft: { mutate: mocks.update },
      setVenueLocationAvailability: { mutate: mocks.availability },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { VenueLocationAuthoring } from './VenueLocationAuthoring'

const revision = new Date('2026-08-23T18:00:00.000Z')
const location = {
  id: '11111111-1111-4111-8111-111111111111',
  stableKey: 'east-entrance',
  kind: 'ENTRANCE',
  displayName: 'East entrance',
  description: 'Accessible from Museum Way.',
  visibility: 'PUBLIC',
  floorId: null,
  parentLocationId: null,
  coordinates: null,
  mapAnchor: { x: 12.5, y: 40 },
  externalMapReference: 'https://museum.example/map',
  isActive: false,
  verifiedAt: revision,
  updatedAt: revision,
}

describe('VenueLocationAuthoring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('crypto', {
      randomUUID: () => '22222222-2222-4222-8222-222222222222',
    })
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('explains the review boundary and renders an honest empty state', () => {
    render(
      <VenueLocationAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="Museum"
        floors={[]}
        initialLocations={[]}
        connectionCount={0}
      />,
    )
    expect(screen.getByText('No location anchors yet')).toBeTruthy()
    expect(screen.getByText(/Nothing is exposed to guests automatically/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save review-only draft' })).toBeTruthy()
  })

  it('creates only an inactive draft with paired coordinates', async () => {
    mocks.create.mockResolvedValue({ replayed: false })
    render(
      <VenueLocationAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="Museum"
        floors={[]}
        initialLocations={[]}
        connectionCount={0}
      />,
    )
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'East entrance' } })
    fireEvent.change(screen.getByLabelText('Stable key'), { target: { value: 'east-entrance' } })
    fireEvent.change(screen.getByLabelText('Latitude'), { target: { value: '41.5' } })
    fireEvent.change(screen.getByLabelText('Longitude'), { target: { value: '-93.6' } })
    fireEvent.submit(
      screen.getByRole('button', { name: 'Save review-only draft' }).closest('form')!,
    )
    await waitFor(() =>
      expect(mocks.create).toHaveBeenCalledWith(
        expect.objectContaining({
          operationId: '22222222-2222-4222-8222-222222222222',
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          stableKey: 'east-entrance',
          coordinates: { latitude: 41.5, longitude: -93.6 },
        }),
      ),
    )
    expect(screen.getByText(/remains invisible to guests/)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('requires a reason before activating the exact reviewed revision', async () => {
    mocks.availability.mockResolvedValue({ replayed: false })
    render(
      <VenueLocationAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="Museum"
        floors={[]}
        initialLocations={[location]}
        connectionCount={0}
      />,
    )
    const button = screen.getByRole('button', { name: 'Activate verified anchor' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Review reason'), {
      target: { value: 'Verified against the current visitor map.' },
    })
    fireEvent.click(button)
    await waitFor(() =>
      expect(mocks.availability).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        locationId: location.id,
        expectedUpdatedAt: revision,
        active: true,
        reason: 'Verified against the current visitor map.',
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('corrects an inactive draft with its exact revision and a human reason', async () => {
    mocks.update.mockResolvedValue({ updatedAt: new Date() })
    render(
      <VenueLocationAuthoring
        tenantId="tenant-1"
        venueId="venue-1"
        venueName="Museum"
        floors={[]}
        initialLocations={[location]}
        connectionCount={0}
      />,
    )
    fireEvent.click(screen.getByText('Edit draft'))
    fireEvent.change(screen.getAllByLabelText('Display name')[1]!, {
      target: { value: 'Accessible east entrance' },
    })
    fireEvent.change(screen.getByLabelText('Change reason'), {
      target: { value: 'Corrected against the current visitor map.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Update review-only draft' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          locationId: location.id,
          expectedUpdatedAt: revision,
          displayName: 'Accessible east entrance',
          reason: 'Corrected against the current visitor map.',
        }),
      ),
    )
    expect(screen.getByText(/still requires separate activation review/)).toBeTruthy()
  })
})
