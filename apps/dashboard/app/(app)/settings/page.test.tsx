/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  listPendingInvitations: vi.fn(),
  inviteMember: vi.fn(),
}))

vi.mock('../../../lib/trpc', () => {
  const client = {
    tenant: {
      getSettings: { query: mocks.getSettings },
      listPendingInvitations: { query: mocks.listPendingInvitations },
      inviteMember: { mutate: mocks.inviteMember },
    },
  }
  return { useTRPCClient: () => client }
})
vi.mock('../../../components/ClientTochiPreferenceWorkspace', () => ({
  ClientTochiPreferenceWorkspace: () => <p>Assistant preference</p>,
}))

import SettingsPage from './page'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const settings = {
  tenant: { name: 'Harbor Museum', planTier: 'pro', status: 'ACTIVE' },
  members: [],
  canManageTeam: true,
}

describe('SettingsPage request lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getSettings.mockResolvedValue(settings)
    mocks.listPendingInvitations.mockResolvedValue([])
  })

  afterEach(cleanup)

  it('loads settings and invitations through cancellable transports', async () => {
    render(<SettingsPage />)

    expect(await screen.findByText('Harbor Museum')).toBeTruthy()
    await waitFor(() => expect(mocks.listPendingInvitations).toHaveBeenCalledOnce())
    expect(mocks.getSettings).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
    expect(mocks.listPendingInvitations).toHaveBeenCalledWith(undefined, {
      signal: expect.any(AbortSignal),
    })
  })

  it('aborts an in-flight settings read on unmount', async () => {
    let signal: AbortSignal | undefined
    mocks.getSettings.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal
        return new Promise(() => undefined)
      },
    )
    const rendered = render(<SettingsPage />)

    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    expect(signal?.aborted).toBe(false)
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('aborts an in-flight invitation read on unmount', async () => {
    let signal: AbortSignal | undefined
    mocks.listPendingInvitations.mockImplementationOnce(
      (_input: unknown, options: { signal: AbortSignal }) => {
        signal = options.signal
        return new Promise(() => undefined)
      },
    )
    const rendered = render(<SettingsPage />)

    expect(await screen.findByText('Harbor Museum')).toBeTruthy()
    await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal))
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })
})
