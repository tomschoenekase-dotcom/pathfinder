/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), query: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      recordApprovalDecision: { mutate: mocks.mutate },
      getApprovalRequest: { query: mocks.query },
    },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))
import { ApprovalDecisionForm } from './ApprovalDecisionForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('ApprovalDecisionForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('records a human decision while explicitly reporting no execution', async () => {
    mocks.mutate.mockResolvedValue({ decision: { id: 'decision_1' }, executionTriggered: false })
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="publish update"
      />,
    )
    expect(screen.getByText(/does not run, apply, publish, retry, or enqueue/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText('APPROVED'))
    fireEvent.change(screen.getByLabelText('Decision reason (optional)'), {
      target: { value: 'Evidence reviewed' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record approved decision' }))
    await waitFor(() =>
      expect(screen.getByText('APPROVED decision recorded. No action was executed.')).toBeTruthy(),
    )
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      approvalRequestId: 'approval_1',
      decision: 'APPROVED',
      reason: 'Evidence reviewed',
    })
  })

  it('serializes writes and requires a state refresh after an ambiguous outcome', async () => {
    let reject!: (reason: unknown) => void
    mocks.mutate.mockReturnValue(
      new Promise((_resolve, rejectPromise) => {
        reject = rejectPromise
      }),
    )
    render(
      <ApprovalDecisionForm
        tenantId="tenant_1"
        venueId="venue_1"
        approvalRequestId="approval_1"
        proposedAction="publish update"
      />,
    )
    const submit = screen.getByRole('button', { name: 'Record rejected decision' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    expect(mocks.mutate).toHaveBeenCalledTimes(1)
    reject(new Error('network'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be confirmed'),
    )
    expect(screen.getByRole('button', { name: 'Refresh approval state' })).toBeTruthy()
  })
})
