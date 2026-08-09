/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), reset: vi.fn(), refresh: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      setAiCostBudget: { mutate: mocks.mutate },
      resetAiCostBudgetWindow: { mutate: mocks.reset },
    },
  }),
}))

import { AdminAiCostBudgetForm } from './AdminAiCostBudgetForm'

const initialState = {
  configured: true,
  enabled: true,
  startsAt: '2026-08-08T20:00:00.000Z',
  endsAt: '2027-08-09T20:00:00.000Z',
  hardLimitUsd: '100.00000000',
  remainingUsd: '90.00000000',
  reservedUsd: '2.00000000',
  committedUsd: '8.00000000',
  revision: 3,
  breachedAt: null,
  reason: 'Synthetic operating envelope',
  updatedAt: '2026-08-08T20:00:00.000Z',
  updatedBy: 'admin_1',
}

describe('AdminAiCostBudgetForm', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('shows exact counters and submits the displayed revision', async () => {
    mocks.mutate.mockResolvedValueOnce({
      configured: true,
      enabled: true,
      startsAt: new Date(initialState.startsAt),
      endsAt: new Date(initialState.endsAt),
      hardLimitUsd: '100.00000000',
      remainingUsd: '90.00000000',
      reservedUsd: '2.00000000',
      committedUsd: '8.00000000',
      epoch: 1,
      revision: 4,
      breachedAt: null,
      reason: initialState.reason,
      updatedAt: new Date('2026-08-08T20:01:00.000Z'),
      updatedBy: 'admin_1',
      version: 'gateway-v1',
      excludedProviderPaths: ['weekly-digest', 'media-ingestion'],
      replayed: false,
    })
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)

    expect(screen.getByText('Committed', { exact: false }).textContent).toContain('$8.00000000')
    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledOnce())
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant_1',
        enabled: true,
        hardLimitUsd: '100.00000000',
        reason: 'Synthetic operating envelope',
        expectedRevision: 3,
      }),
    )
    expect(await screen.findByText('AI cost budget saved.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('keeps a failed CAS visible and refreshes authoritative state', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('AI cost budget changed; refresh and try again.'))
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={initialState} />)

    fireEvent.click(screen.getByRole('button', { name: 'Save AI budget' }))
    expect(await screen.findByText('AI cost budget changed; refresh and try again.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('requires a persisted disabled state and confirmation before resetting an epoch', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const disabledState = { ...initialState, enabled: false, reservedUsd: '0.00000000' }
    mocks.reset.mockResolvedValueOnce({
      configured: true,
      enabled: false,
      startsAt: new Date(disabledState.startsAt),
      endsAt: new Date(disabledState.endsAt),
      hardLimitUsd: '100.00000000',
      remainingUsd: '100.00000000',
      reservedUsd: '0.00000000',
      committedUsd: '0.00000000',
      epoch: 2,
      revision: 4,
      breachedAt: null,
      reason: disabledState.reason,
      updatedAt: new Date('2026-08-08T20:02:00.000Z'),
      updatedBy: 'admin_1',
      version: 'gateway-v1',
      excludedProviderPaths: ['weekly-digest', 'media-ingestion'],
      reconciliation: { scanned: 1, settled: 1, raced: 0 },
    })
    render(<AdminAiCostBudgetForm tenantId="tenant_1" initialState={disabledState} />)

    fireEvent.click(screen.getByRole('button', { name: 'Reset disabled window' }))

    await waitFor(() => expect(mocks.reset).toHaveBeenCalledOnce())
    expect(confirm).toHaveBeenCalledOnce()
    expect(mocks.reset).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_1', expectedRevision: 3 }),
    )
    expect(await screen.findByText(/AI cost budget window reset/)).toBeTruthy()
    confirm.mockRestore()
  })
})
