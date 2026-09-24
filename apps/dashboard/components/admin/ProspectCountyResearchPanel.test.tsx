// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ProspectCountyResearchPanel } from './ProspectCountyResearchPanel'
const api = vi.hoisted(() => ({
  readCountyResearch: { query: vi.fn() },
  readCountyDiscoveries: { query: vi.fn() },
  claimCountyResearch: { mutate: vi.fn() },
  renewCountyResearch: { mutate: vi.fn() },
  releaseCountyResearch: { mutate: vi.fn() },
  completeCountyResearch: { mutate: vi.fn() },
  decideCountyDiscovery: { mutate: vi.fn() },
}))
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => ({ admin: api }) }))
const hash = '787a6f81f90f4a51d3cc29bbf12d9e88ef49598a6f1747ff74b8cac13a629610'
beforeEach(() => {
  vi.stubGlobal('React', React)
  vi.clearAllMocks()
  api.readCountyResearch.query.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    limit: 10,
    hasMore: false,
  })
  api.readCountyDiscoveries.query.mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    limit: 10,
    hasMore: false,
  })
  api.claimCountyResearch.mutate.mockResolvedValue({ receiptId: 'synthetic-lease-receipt' })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function loaded() {
  render(<ProspectCountyResearchPanel registryHash={hash} />)
  fireEvent.click(screen.getByRole('button', { name: 'Load county work' }))
  await screen.findByText(/No county claim matches this filter/)
}
function fillClaim() {
  fireEvent.change(screen.getByLabelText('Exact five-digit county GEOID'), {
    target: { value: '17031' },
  })
  fireEvent.change(screen.getByLabelText('Planned locality or area'), {
    target: { value: 'Synthetic test locality' },
  })
  fireEvent.change(screen.getByLabelText('Planned venue category'), { target: { value: 'Museum' } })
  fireEvent.change(screen.getByLabelText('Specific research question'), {
    target: { value: 'Which exact physical visitor sites have authoritative county evidence?' },
  })
}
describe('authenticated county controls — isolated UI transport, not hosted authentication', () => {
  it('does not claim or discover anything merely by opening the panel', () => {
    render(<ProspectCountyResearchPanel registryHash={hash} />)
    expect(api.readCountyResearch.query).not.toHaveBeenCalled()
    expect(api.claimCountyResearch.mutate).not.toHaveBeenCalled()
    expect(api.decideCountyDiscovery.mutate).not.toHaveBeenCalled()
  })
  it('distinguishes an unavailable instance from an empty queue', async () => {
    api.readCountyResearch.query.mockRejectedValueOnce(new Error('Missing migration'))
    render(<ProspectCountyResearchPanel registryHash={hash} />)
    fireEvent.click(screen.getByRole('button', { name: 'Load county work' }))
    await screen.findByRole('alert')
    expect(screen.queryByText(/No county claim matches/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Acquire county claim' })).toBeNull()
  })
  it('retains exact county filtering without starting research', async () => {
    render(<ProspectCountyResearchPanel registryHash={hash} />)
    fireEvent.change(screen.getByLabelText('County GEOID filter'), { target: { value: '17031' } })
    fireEvent.click(screen.getByRole('button', { name: 'Load county work' }))
    await waitFor(() =>
      expect(api.readCountyResearch.query).toHaveBeenCalledWith(
        {
          countyGeoid: '17031',
          page: 1,
          limit: 10,
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    )
    expect(api.claimCountyResearch.mutate).not.toHaveBeenCalled()
  })
  it('uses a bounded whole-county claim and never supplies human authority in the payload', async () => {
    await loaded()
    fillClaim()
    fireEvent.click(screen.getByRole('button', { name: 'Acquire county claim' }))
    await waitFor(() => expect(api.claimCountyResearch.mutate).toHaveBeenCalledOnce())
    const input = api.claimCountyResearch.mutate.mock.calls[0]![0]
    expect(input).toMatchObject({
      countyGeoid: '17031',
      scopeKind: 'WHOLE_COUNTY',
      leaseSeconds: 900,
      expectedRegistryHash: hash,
    })
    expect(input.plannedCells).toHaveLength(1)
    expect(input).not.toHaveProperty('actor')
    expect(input).not.toHaveProperty('actorType')
  })
  it('preserves the exact lost-response claim input and key for retry', async () => {
    await loaded()
    fillClaim()
    api.claimCountyResearch.mutate.mockRejectedValueOnce(new Error('Lost response'))
    fireEvent.click(screen.getByRole('button', { name: 'Acquire county claim' }))
    await screen.findByRole('alert')
    const first = api.claimCountyResearch.mutate.mock.calls[0]![0]
    fireEvent.change(screen.getByLabelText('Planned locality or area'), {
      target: { value: 'Changed UI text' },
    })
    expect(
      (screen.getByRole('button', { name: 'Acquire county claim' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry identical county request' }))
    await waitFor(() => expect(api.claimCountyResearch.mutate).toHaveBeenCalledTimes(2))
    expect(api.claimCountyResearch.mutate.mock.calls[1]![0]).toEqual(first)
    await screen.findByText(/Receipt: synthetic-lease-receipt/)
  })
})
