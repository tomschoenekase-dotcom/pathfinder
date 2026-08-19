/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentOutcomeObservationForm } from './AgentOutcomeObservationForm'

const mutate = vi.fn()
const refresh = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { recordAgentRunOutcome: { mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
;(globalThis as typeof globalThis & { React: typeof React }).React = React

describe('AgentOutcomeObservationForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('records explicit evidence without claiming execution or approval', async () => {
    mutate.mockResolvedValue({ id: 'outcome-1', replayed: false })
    render(<AgentOutcomeObservationForm tenantId="tenant-1" venueId="venue-1" agentRunId="run-1" />)

    fireEvent.change(screen.getByLabelText('Verdict'), { target: { value: 'MIXED' } })
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: ' Useful after correcting the estimate. ' },
    })
    fireEvent.change(screen.getByLabelText('Evidence reference (optional)'), {
      target: { value: ' decision-42 ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record observation' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate).toHaveBeenCalledWith({
      operationId: expect.any(String),
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      verdict: 'MIXED',
      summary: 'Useful after correcting the estimate.',
      evidenceRef: 'decision-42',
    })
    expect(await screen.findByText(/status and execution authority were unchanged/i)).toBeTruthy()
    expect(screen.queryByText(/approved|resumed|completed/i)).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('retains the same operation identity after an ambiguous failure', async () => {
    mutate.mockRejectedValueOnce(new Error('unknown outcome')).mockResolvedValueOnce({
      id: 'outcome-1',
      replayed: true,
    })
    render(<AgentOutcomeObservationForm tenantId="tenant-1" venueId="venue-1" agentRunId="run-1" />)
    fireEvent.change(screen.getByLabelText('What happened?'), {
      target: { value: 'Accepted.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Record observation' }))
    expect(await screen.findByText(/same operation identity/i)).toBeTruthy()
    const firstOperationId = mutate.mock.calls[0]?.[0].operationId

    fireEvent.click(screen.getByRole('button', { name: 'Record observation' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0].operationId).toBe(firstOperationId)
  })
})
