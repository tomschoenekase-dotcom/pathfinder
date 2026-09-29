/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  setSurfaceState: vi.fn(),
  addOrigin: vi.fn(),
  revokeOrigin: vi.fn(),
  applyProposal: vi.fn(),
  refresh: vi.fn(),
}))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      venueDistribution: {
        setSurfaceState: { mutate: mocks.setSurfaceState },
        addOrigin: { mutate: mocks.addOrigin },
        revokeOrigin: { mutate: mocks.revokeOrigin },
        applyProposal: { mutate: mocks.applyProposal },
      },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { AdminVenueDistributionPanel, placeIdsCsv } from './AdminVenueDistributionPanel'

const props = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  website: {
    state: 'DISABLED' as const,
    effective: false,
    reason: 'SURFACE_DISABLED',
    framed: false,
    frameReason: null,
  },
  app: { state: 'DISABLED' as const, effective: false, reason: 'SURFACE_DISABLED' },
  revision: 2,
  origins: [],
  sessions30d: { direct: 3, qr: 2, website: 0, app: 0, unknown: 1 },
  artifacts: [],
  previewUrl: null,
}

describe('AdminVenueDistributionPanel', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('requires an audit reason before enabling a surface and submits the scoped revision change', async () => {
    mocks.setSurfaceState.mockResolvedValue({ revision: 3 })
    render(<AdminVenueDistributionPanel {...props} />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable' })[0]!)
    expect(screen.getByRole('alert').textContent).toContain('Add a reason')
    expect(mocks.setSurfaceState).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText(/Reason recorded in the audit log/), {
      target: { value: 'Approved website launch' },
    })
    fireEvent.click(screen.getAllByRole('button', { name: 'Enable' })[0]!)
    await waitFor(() =>
      expect(mocks.setSurfaceState).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        surface: 'website',
        state: 'ENABLED',
        reason: 'Approved website launch',
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('lists public place IDs for partner mapping and copies them as CSV', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const publicPlaces = [
      { id: 'place-1', name: 'Harbor Aquarium', type: 'ATTRACTION' },
      { id: 'place-2', name: 'Deck "94", Skyline', type: 'OBSERVATION_DECK' },
    ]
    render(
      <AdminVenueDistributionPanel {...props} publicPlaces={publicPlaces} appHandBacks30d={12} />,
    )
    expect(screen.getByText(/Sent back to the partner app/).textContent).toContain('12')
    expect(
      screen.getByRole('heading', { name: 'Place IDs for app and website hosts' }),
    ).toBeTruthy()
    expect(screen.getByText('place-2')).toBeTruthy()
    expect(screen.getByText('observation deck')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Copy place list (CSV)' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(placeIdsCsv(publicPlaces)))
    expect(placeIdsCsv(publicPlaces).split('\n')).toEqual([
      'place_id,name,type',
      'place-1,Harbor Aquarium,ATTRACTION',
      'place-2,"Deck ""94"", Skyline",OBSERVATION_DECK',
    ])
  })

  it('says when a venue has no public places and omits the section without data', () => {
    const { rerender } = render(<AdminVenueDistributionPanel {...props} publicPlaces={[]} />)
    expect(screen.getByText('This venue has no active public places yet.')).toBeTruthy()
    rerender(<AdminVenueDistributionPanel {...props} />)
    expect(screen.queryByRole('heading', { name: /Place IDs/ })).toBeNull()
  })
})
