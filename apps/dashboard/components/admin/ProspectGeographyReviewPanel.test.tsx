// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  ProspectGeographyReviewPanel,
  type GeographyReviewTransport,
} from './ProspectGeographyReviewPanel'

vi.mock('../../lib/trpc', () => ({ useTRPCClient: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
type Geography = Awaited<ReturnType<GeographyReviewTransport['load']>>
type Proposals = Awaited<ReturnType<GeographyReviewTransport['proposals']>>
const evidence = {
  venueId: 'fixture-venue',
  countyGeoid: '17031',
  state: 'IL',
  countyVintage: '2025 Census Gazetteer',
  physicalAddress: '123 Synthetic Example Street, Chicago, IL',
  anchorKind: 'PHYSICAL_STREET_ADDRESS',
  method: 'OFFICIAL_PHYSICAL_COUNTY',
  addressSourceUrl: 'https://museum.example.org/visit',
  countySourceUrl: 'https://county.example.org/property',
  addressQuote: 'Synthetic address evidence for unit testing only.',
  countyQuote: 'Synthetic Cook County evidence for unit testing only.',
  observedAt: '2026-09-22',
  sourceResultHash: 'a'.repeat(64),
  uncertain: false,
  conflicting: false,
} as const
function fixture(assigned = false) {
  const geography = {
    venueId: evidence.venueId,
    version: 'fixture-version',
    registryHash: 'a'.repeat(64),
    venue: {
      id: evidence.venueId,
      organizationId: 'fixture-org',
      name: 'Synthetic visitor site',
      city: 'Chicago',
      region: 'IL',
      website: 'https://museum.example.org',
      updatedAt: new Date('2026-09-22T12:00:00.000Z'),
    },
    geography: {
      status: assigned ? 'ASSIGNED' : 'GEO_HOLD',
      revision: 2,
      legacyTerritory: { name: 'Legacy fixture' },
      county: assigned ? { countyName: 'Cook County' } : null,
    },
    territory: assigned ? { name: 'Cook' } : null,
    physicalEvidence: assigned ? evidence : null,
  } as unknown as Geography
  const proposals = {
    venueId: evidence.venueId,
    total: 1,
    page: 1,
    limit: 20,
    hasMore: false,
    canonicalFieldsApplied: false,
    items: [
      {
        reviewId: 'fixture-review',
        revision: 3,
        status: 'OPEN',
        reason: 'Synthetic review',
        stale: false,
        proposal: {
          venueId: evidence.venueId,
          expectedVenueUpdatedAt: '2026-09-22T12:00:00.000Z',
          expectedRevision: 2,
          expectedRegistryHash: 'a'.repeat(64),
          evidence,
        },
        decision: null,
        createdAt: new Date('2026-09-22T12:00:00.000Z'),
      },
    ],
  } as unknown as Proposals
  const transport = {
    load: vi.fn().mockResolvedValue(geography),
    proposals: vi.fn().mockResolvedValue(proposals),
    resolve: vi.fn().mockResolvedValue({ receiptId: 'durable-fixture-receipt' }),
    invalidate: vi.fn().mockResolvedValue({ receiptId: 'durable-fixture-reopen' }),
    confirmed: vi.fn(),
  }
  return { geography, proposals, transport }
}
const reason = 'The synthetic sources identify this exact visitor site.'
async function ready(transport: GeographyReviewTransport) {
  render(<ProspectGeographyReviewPanel venueId={evidence.venueId} transport={transport} />)
  await screen.findByRole('heading', { name: 'Synthetic visitor site' })
  fireEvent.change(screen.getByLabelText('Decision reason'), { target: { value: reason } })
}
beforeEach(() => vi.stubGlobal('React', React))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('native geography review panel — isolated transport, not hosted authentication', () => {
  it('keeps acceptance disabled until the sources are acknowledged', async () => {
    const { transport } = fixture()
    await ready(transport)
    expect(
      (screen.getByRole('button', { name: 'Accept county evidence' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByLabelText(/I checked both sources/))
    fireEvent.click(screen.getByRole('button', { name: 'Accept county evidence' }))
    await waitFor(() => expect(transport.resolve).toHaveBeenCalledOnce())
    expect(transport.resolve.mock.calls[0]![0]).toMatchObject({
      reviewId: 'fixture-review',
      expectedReviewRevision: 3,
      reason,
      decision: 'ACCEPT',
    })
    expect(transport.resolve.mock.calls[0]![0]).not.toHaveProperty('actor')
    await waitFor(() => expect(transport.confirmed).toHaveBeenCalledOnce())
  })
  it('recovers a lost response using the identical original input and key', async () => {
    const { transport } = fixture()
    transport.resolve.mockRejectedValueOnce(new Error('Response lost after server commit'))
    await ready(transport)
    fireEvent.click(screen.getByLabelText(/I checked both sources/))
    fireEvent.click(screen.getByRole('button', { name: 'Accept county evidence' }))
    await screen.findByRole('alert')
    const first = transport.resolve.mock.calls[0]![0]
    fireEvent.change(screen.getByLabelText('Decision reason'), {
      target: { value: 'Changed form text must not change the pending request.' },
    })
    expect(
      (screen.getByRole('button', { name: 'Reject proposal' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry the same request' }))
    await waitFor(() => expect(transport.resolve).toHaveBeenCalledTimes(2))
    expect(transport.resolve.mock.calls[1]![0]).toEqual(first)
    await screen.findByText(/Receipt: durable-fixture-receipt/)
    expect(screen.queryByRole('button', { name: 'Retry the same request' })).toBeNull()
  })
  it('does not call a receipt-less response confirmed', async () => {
    const { transport } = fixture()
    transport.resolve.mockResolvedValue({})
    await ready(transport)
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }))
    await screen.findByRole('alert')
    expect(transport.confirmed).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Retry the same request' })).toBeTruthy()
  })
  it('removes old actionable content when a reload fails', async () => {
    const { transport } = fixture()
    await ready(transport)
    transport.load.mockRejectedValueOnce(new Error('Disconnected'))
    fireEvent.click(screen.getByRole('button', { name: 'Reload location' }))
    await screen.findByRole('alert')
    expect(screen.queryByRole('button', { name: 'Accept county evidence' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull()
    expect(transport.resolve).not.toHaveBeenCalled()
  })
  it('allows rejecting but not accepting a stale proposal', async () => {
    const { transport, proposals } = fixture()
    proposals.items[0]!.stale = true
    await ready(transport)
    fireEvent.click(screen.getByLabelText(/I checked both sources/))
    expect(
      (screen.getByRole('button', { name: 'Accept county evidence' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }))
    await waitFor(() => expect(transport.resolve).toHaveBeenCalledOnce())
    expect(transport.resolve.mock.calls[0]![0]).toMatchObject({ decision: 'REJECT' })
  })
  it('shows admitted evidence and reopens against the exact native version', async () => {
    const { transport } = fixture(true)
    await ready(transport)
    expect(screen.getByText('Current assignment evidence')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Authoritative county' }).getAttribute('href')).toBe(
      evidence.countySourceUrl,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Reopen county assignment' }))
    await waitFor(() => expect(transport.invalidate).toHaveBeenCalledOnce())
    expect(transport.invalidate.mock.calls[0]![0]).toMatchObject({
      venueId: evidence.venueId,
      expectedRevision: 2,
      expectedVenueUpdatedAt: '2026-09-22T12:00:00.000Z',
      reason,
    })
  })
  it('provides no approval controls through the read-only local transport', async () => {
    const { transport } = fixture()
    render(
      <ProspectGeographyReviewPanel
        venueId={evidence.venueId}
        transport={{ load: transport.load, proposals: transport.proposals }}
      />,
    )
    await screen.findByRole('heading', { name: 'Synthetic visitor site' })
    expect(screen.queryByLabelText('Decision reason')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Accept county evidence' })).toBeNull()
  })
  it('turns a hung mutation into an identical-retry state rather than remaining busy forever', async () => {
    const { transport } = fixture()
    await ready(transport)
    transport.resolve.mockImplementationOnce(() => new Promise(() => {}))
    vi.useFakeTimers()
    fireEvent.click(screen.getByRole('button', { name: 'Reject proposal' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20001)
    })
    expect(screen.getByRole('alert').textContent).toContain('unconfirmed')
    expect(
      (screen.getByRole('button', { name: 'Retry the same request' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false)
    expect(transport.resolve).toHaveBeenCalledOnce()
  })
})
