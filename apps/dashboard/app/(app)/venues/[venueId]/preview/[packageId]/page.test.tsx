import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ lifecycles: vi.fn(), preview: vi.fn(), noStore: vi.fn() }))
vi.mock('next/cache', () => ({ unstable_noStore: mocks.noStore }))
vi.mock('../../../../../../lib/server-caller', () => ({
  createDashboardCaller: vi.fn(async () => ({
    portal: { getVenueLifecycles: mocks.lifecycles, getClientPreview: mocks.preview },
  })),
}))

import ClientPackagePreviewPage from './page'

describe('ClientPackagePreviewPage', () => {
  beforeEach(() => vi.clearAllMocks())

  it('loads only the exact lifecycle-authorized venue and package without cache', async () => {
    mocks.lifecycles.mockResolvedValue([
      {
        venueId: 'venue_1',
        lifecycle: { state: 'CLIENT_PREVIEW' },
        clientPreview: { state: 'AVAILABLE', id: 'package_1' },
      },
    ])
    mocks.preview.mockResolvedValue({ venue: { name: 'Museum' } })
    const result = await ClientPackagePreviewPage({
      params: Promise.resolve({ venueId: 'venue_1', packageId: 'package_1' }),
    })
    expect(mocks.noStore).toHaveBeenCalledOnce()
    expect(mocks.preview).toHaveBeenCalledWith({ venueId: 'venue_1', packageId: 'package_1' })
    expect(result.type.name).toBe('ClientPackagePreview')
  })

  it.each([
    [
      {
        venueId: 'venue_1',
        lifecycle: { state: 'CLIENT_PREVIEW' },
        clientPreview: { state: 'SUPERSEDED', id: null },
      },
      true,
    ],
    [
      {
        venueId: 'venue_1',
        lifecycle: { state: 'READY' },
        clientPreview: { state: 'UNAVAILABLE', id: null },
      },
      false,
    ],
  ])(
    'fails closed without loading package projection for unavailable lifecycle evidence',
    async (row, superseded) => {
      mocks.lifecycles.mockResolvedValue([row])
      const result = await ClientPackagePreviewPage({
        params: Promise.resolve({ venueId: 'venue_1', packageId: 'old_package' }),
      })

      expect(mocks.preview).not.toHaveBeenCalled()
      expect(result.props.superseded).toBe(superseded)
    },
  )

  it('renders only controlled staleness as superseded and rethrows unknown failures', async () => {
    mocks.lifecycles.mockResolvedValue([
      {
        venueId: 'venue_1',
        lifecycle: { state: 'CLIENT_PREVIEW' },
        clientPreview: { state: 'AVAILABLE', id: 'package_1' },
      },
    ])
    mocks.preview.mockRejectedValueOnce({ data: { code: 'CONFLICT' } })
    const stale = await ClientPackagePreviewPage({
      params: Promise.resolve({ venueId: 'venue_1', packageId: 'package_1' }),
    })
    expect(stale.props.superseded).toBe(true)

    const failure = new Error('Database unavailable')
    mocks.preview.mockRejectedValueOnce(failure)
    await expect(
      ClientPackagePreviewPage({
        params: Promise.resolve({ venueId: 'venue_1', packageId: 'package_1' }),
      }),
    ).rejects.toBe(failure)

    const invalid = { data: { code: 'PRECONDITION_FAILED' } }
    mocks.preview.mockRejectedValueOnce(invalid)
    await expect(
      ClientPackagePreviewPage({
        params: Promise.resolve({ venueId: 'venue_1', packageId: 'package_1' }),
      }),
    ).rejects.toBe(invalid)
  })
})
