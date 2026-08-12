/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AdminClientPlanForm } from './AdminClientPlanForm'
import { AdminClientStatusForm } from './AdminClientStatusForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  updatePlan: vi.fn(),
  updateStatus: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      updateClientPlanTier: { mutate: mocks.updatePlan },
      updateClientStatus: { mutate: mocks.updateStatus },
    },
  }),
}))

const revision = '2026-08-11T14:30:00.000Z'

describe('platform client account forms', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updatePlan.mockResolvedValue({ ok: true })
    mocks.updateStatus.mockResolvedValue({ ok: true })
  })
  afterEach(cleanup)

  it('sends the server-provided tenant revision with status and plan changes', async () => {
    render(
      <>
        <AdminClientStatusForm
          tenantId="tenant-1"
          currentStatus="ACTIVE"
          expectedUpdatedAt={revision}
        />
        <AdminClientPlanForm
          tenantId="tenant-1"
          currentPlanTier="free"
          expectedUpdatedAt={revision}
        />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set Suspended' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }))
    await waitFor(() => {
      expect(mocks.updateStatus).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        status: 'SUSPENDED',
        expectedUpdatedAt: revision,
      })
      expect(mocks.updatePlan).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        planTier: 'pro',
        expectedUpdatedAt: revision,
      })
    })
  })

  it('surfaces a CAS conflict and does not claim success', async () => {
    mocks.updateStatus.mockRejectedValueOnce(new Error('Client account changed; refresh and retry'))
    render(
      <AdminClientStatusForm
        tenantId="tenant-1"
        currentStatus="ACTIVE"
        expectedUpdatedAt={revision}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Set Suspended' }))
    expect(await screen.findByText(/Client account changed/)).toBeTruthy()
    expect(screen.queryByText(/updated to suspended/)).toBeNull()
  })

  it('synchronously fences same-tick duplicate status and plan clicks', () => {
    mocks.updateStatus.mockImplementation(() => new Promise(() => undefined))
    mocks.updatePlan.mockImplementation(() => new Promise(() => undefined))
    render(
      <>
        <AdminClientStatusForm
          tenantId="tenant-1"
          currentStatus="ACTIVE"
          expectedUpdatedAt={revision}
        />
        <AdminClientPlanForm
          tenantId="tenant-1"
          currentPlanTier="free"
          expectedUpdatedAt={revision}
        />
      </>,
    )
    const status = screen.getByRole('button', { name: 'Set Suspended' })
    const plan = screen.getByRole('button', { name: 'Pro' })
    fireEvent.click(status)
    fireEvent.click(status)
    fireEvent.click(plan)
    fireEvent.click(plan)
    expect(mocks.updateStatus).toHaveBeenCalledOnce()
    expect(mocks.updatePlan).toHaveBeenCalledOnce()
  })
})
