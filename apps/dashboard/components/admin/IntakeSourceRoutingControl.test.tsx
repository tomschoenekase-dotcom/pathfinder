/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const query = vi.fn()
  const mutate = vi.fn()
  const client = {
    admin: {
      getIntakeSourceAgentRouting: { query },
      listIntakeSourceAgentRoutingCandidates: { query: vi.fn() },
      configureIntakeSourceAgentRouting: { mutate },
    },
  }
  return { query, mutate, client, currentClient: client }
})

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.currentClient }))

import { IntakeSourceRoutingControl } from './IntakeSourceRoutingControl'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const eligible = {
  id: 'identity-1',
  name: 'Source specialist',
  agentType: 'CONTENT',
  enabled: true,
  accessCapabilities: ['intake.read', 'content.draft'],
  autonomyLevel: 'ASSISTED',
  autonomousActions: ['content.prepare-draft'],
  defaultProvider: 'anthropic',
  defaultModel: 'claude',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

describe('IntakeSourceRoutingControl', () => {
  beforeEach(() => {
    mocks.currentClient = mocks.client
    mocks.query.mockReset().mockResolvedValue(null)
    mocks.mutate.mockReset()
    mocks.client.admin.listIntakeSourceAgentRoutingCandidates.query.mockReset().mockResolvedValue({
      items: [eligible],
      nextCursor: null,
    })
  })
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('loads a missing policy default-off without selecting an identity', async () => {
    render(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )

    const select = await screen.findByLabelText('Content specialist')
    expect((select as HTMLSelectElement).value).toBe('')
    expect(
      (screen.getByLabelText('Enable source review preparation') as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (screen.getByRole('button', { name: 'Save routing' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mocks.mutate).not.toHaveBeenCalled()
  })

  it('offers a canonical retry after the first read fails', async () => {
    mocks.query.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(null)
    render(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )

    expect((await screen.findByRole('alert')).textContent).toMatch(/could not be loaded/i)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh configuration' }))
    expect(await screen.findByLabelText('Content specialist')).toBeTruthy()
    expect(mocks.query).toHaveBeenCalledTimes(2)
  })

  it('saves the exact selected identity and revision', async () => {
    mocks.query.mockResolvedValueOnce({
      agentIdentityId: eligible.id,
      enabled: false,
      revision: 4,
    })
    mocks.mutate.mockResolvedValueOnce({
      policy: { agentIdentityId: eligible.id, enabled: true, revision: 5 },
    })
    render(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )

    fireEvent.click(await screen.findByLabelText('Enable source review preparation'))
    fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        agentIdentityId: eligible.id,
        expectedRevision: 4,
        enabled: true,
      },
      { signal: expect.any(AbortSignal) },
    )
    expect(await screen.findByText('Source review routing saved.')).toBeTruthy()
  })

  it.each([
    [{ data: { code: 'CONFLICT' } }, /changed after this page loaded/i],
    [new Error('uncertain'), /outcome could not be confirmed/i],
  ])(
    'requires a canonical refresh after a conflict or unknown outcome',
    async (failure, message) => {
      mocks.query.mockResolvedValueOnce({
        agentIdentityId: eligible.id,
        enabled: false,
        revision: 2,
      })
      mocks.mutate.mockRejectedValueOnce(failure)
      render(
        <IntakeSourceRoutingControl
          tenantId="tenant-1"
          venueId="venue-1"
          identities={[eligible]}
        />,
      )

      await screen.findByLabelText('Content specialist')
      fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))
      expect((await screen.findByRole('alert')).textContent).toMatch(message)
      expect(screen.getByRole('button', { name: 'Refresh configuration' })).toBeTruthy()
      expect(mocks.mutate).toHaveBeenCalledTimes(1)
    },
  )

  it('discards stale save feedback after a scope change', async () => {
    const save = deferred<{
      policy: { agentIdentityId: string; enabled: boolean; revision: number }
    }>()
    mocks.query
      .mockResolvedValueOnce({ agentIdentityId: eligible.id, enabled: false, revision: 3 })
      .mockResolvedValueOnce(null)
    mocks.mutate.mockReturnValueOnce(save.promise)
    const rendered = render(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )
    await screen.findByLabelText('Content specialist')
    fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))
    rendered.rerender(
      <IntakeSourceRoutingControl tenantId="tenant-2" venueId="venue-2" identities={[eligible]} />,
    )
    save.resolve({ policy: { agentIdentityId: eligible.id, enabled: true, revision: 4 } })

    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Source review routing saved.')).toBeNull()
    expect((screen.getByLabelText('Content specialist') as HTMLSelectElement).value).toBe('')
  })

  it('discards an old client read when the client object changes', async () => {
    const oldPolicy = deferred<null>()
    mocks.query.mockReturnValueOnce(oldPolicy.promise)
    const replacementPolicy = vi.fn().mockResolvedValue({
      agentIdentityId: eligible.id,
      enabled: true,
      revision: 9,
    })
    const replacementCandidates = vi.fn().mockResolvedValue({ items: [eligible], nextCursor: null })
    const replacementMutate = vi.fn()
    const rendered = render(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )
    await waitFor(() => expect(mocks.query).toHaveBeenCalledTimes(1))
    const oldSignal = mocks.query.mock.calls[0]?.[1]?.signal as AbortSignal
    mocks.currentClient = {
      admin: {
        getIntakeSourceAgentRouting: { query: replacementPolicy },
        listIntakeSourceAgentRoutingCandidates: { query: replacementCandidates },
        configureIntakeSourceAgentRouting: { mutate: replacementMutate },
      },
    }
    rendered.rerender(
      <IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[eligible]} />,
    )

    expect(oldSignal.aborted).toBe(true)
    const selected = await screen.findByLabelText('Content specialist')
    await waitFor(() => expect((selected as HTMLSelectElement).value).toBe(eligible.id))
    oldPolicy.resolve(null)
    await waitFor(() => expect((selected as HTMLSelectElement).value).toBe(eligible.id))
  })

  it('loads another bounded page of eligible specialists', async () => {
    const later = { ...eligible, id: 'identity-2', name: 'Second specialist' }
    const candidateQuery = mocks.client.admin.listIntakeSourceAgentRoutingCandidates.query
    candidateQuery
      .mockResolvedValueOnce({
        items: [eligible],
        nextCursor: { createdAt: '2026-09-10T00:00:00.000Z', id: eligible.id },
      })
      .mockResolvedValueOnce({ items: [later], nextCursor: null })
    render(<IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" />)

    fireEvent.click(await screen.findByRole('button', { name: 'Load more specialists' }))
    expect(await screen.findByRole('option', { name: later.name })).toBeTruthy()
    expect(candidateQuery).toHaveBeenLastCalledWith(
      {
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        limit: 50,
        cursor: { createdAt: '2026-09-10T00:00:00.000Z', id: eligible.id },
      },
      { signal: expect.any(AbortSignal) },
    )
  })

  it('disables while retaining a configured identity outside the current page', async () => {
    mocks.query.mockResolvedValueOnce({
      agentIdentityId: 'identity-older',
      enabled: true,
      revision: 7,
    })
    mocks.mutate.mockResolvedValueOnce({
      policy: { agentIdentityId: 'identity-older', enabled: false, revision: 8 },
    })
    render(<IntakeSourceRoutingControl tenantId="tenant-1" venueId="venue-1" identities={[]} />)

    const select = await screen.findByLabelText('Content specialist')
    expect((select as HTMLSelectElement).value).toBe('identity-older')
    fireEvent.click(screen.getByLabelText('Enable source review preparation'))
    fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]?.[0]).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentIdentityId: 'identity-older',
      expectedRevision: 7,
      enabled: false,
    })
  })
})
