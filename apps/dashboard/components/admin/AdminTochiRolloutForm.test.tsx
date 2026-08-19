/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
const client = vi.hoisted(() => ({
  admin: { setTochiTenantFlag: { mutate: mocks.mutate } },
}))

vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => client }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { AdminTochiRolloutForm } from './AdminTochiRolloutForm'

const flags = [
  {
    tenantFlagKey: 'client-tochi-v1',
    label: 'Client Tochi',
    description: 'Private portal guidance.',
    globalEnabled: false,
    tenantEnabled: false,
    effective: false,
  },
]

describe('AdminTochiRolloutForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => cleanup())

  it('shows both rollout gates and never calls tenant access effective by itself', () => {
    render(<AdminTochiRolloutForm tenantId="tenant-1" flags={flags} />)
    expect(screen.getByText('Server kill switch: off · Client allowlist: off')).toBeTruthy()
    expect(screen.getByText('Not effective')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Allow for this client' })).toBeTruthy()
  })

  it('changes only the exact client allowlist flag and refreshes authoritative state', async () => {
    mocks.mutate.mockResolvedValue({ enabled: true })
    render(<AdminTochiRolloutForm tenantId="tenant-1" flags={flags} />)
    fireEvent.click(screen.getByRole('button', { name: 'Allow for this client' }))
    await waitFor(() =>
      expect(mocks.mutate).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        flagKey: 'client-tochi-v1',
        enabled: true,
      }),
    )
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })
})
