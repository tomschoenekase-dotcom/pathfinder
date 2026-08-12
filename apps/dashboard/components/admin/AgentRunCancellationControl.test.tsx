/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { requestAgentRunCancellation: { mutate: mocks.mutate } } }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { AgentRunCancellationControl } from './AgentRunCancellationControl'

function renderControl(
  overrides: Partial<React.ComponentProps<typeof AgentRunCancellationControl>> = {},
) {
  return render(
    <AgentRunCancellationControl
      tenantId="tenant-1"
      venueId="venue-1"
      agentRunId="run-1"
      status="RUNNING"
      cancelRequestedAt={null}
      {...overrides}
    />,
  )
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('AgentRunCancellationControl', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(cleanup)

  it('synchronously fences duplicate submissions and sends exact scope with a trimmed reason', async () => {
    const pending = deferred<{
      id: string
      status: string
      cancelRequestedAt: Date
      outcome: 'REQUESTED'
    }>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    renderControl()
    fireEvent.change(screen.getByLabelText('Operator reason'), {
      target: { value: '  Stop before publication  ' },
    })
    const form = screen.getByRole('button', { name: 'Request cancellation' }).closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(mocks.mutate).toHaveBeenCalledOnce()
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      reason: 'Stop before publication',
    })
    pending.resolve({
      id: 'run-1',
      status: 'RUNNING',
      cancelRequestedAt: new Date('2026-08-11T20:00:00.000Z'),
      outcome: 'REQUESTED',
    })
    expect(await screen.findByText('Cancellation request recorded.')).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('preserves the reason without remounting after an ambiguous failure', async () => {
    mocks.mutate.mockRejectedValueOnce(new Error('Transport failed'))
    renderControl()
    const reason = screen.getByLabelText('Operator reason')
    fireEvent.change(reason, { target: { value: 'Stop before publication' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }))
    expect((await screen.findByRole('alert')).textContent).toContain('outcome is unknown')
    expect((reason as HTMLTextAreaElement).value).toBe('Stop before publication')
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('reports a terminal race truthfully without claiming cancellation', async () => {
    mocks.mutate.mockResolvedValueOnce({
      id: 'run-1',
      status: 'COMPLETED',
      cancelRequestedAt: null,
      outcome: 'TERMINAL',
    })
    renderControl()
    fireEvent.change(screen.getByLabelText('Operator reason'), { target: { value: 'Stop now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }))
    expect((await screen.findByRole('status')).textContent).toContain(
      'The run is already completed; no cancellation was requested.',
    )
    expect(screen.queryByText('Cancellation request recorded.')).toBeNull()
  })

  it('renders evidence instead of a control for prior intent or a terminal run', () => {
    const { rerender } = renderControl({
      cancelRequestedAt: new Date('2026-08-11T20:00:00.000Z'),
    })
    expect(screen.getByText(/Cancellation was requested at/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    rerender(
      <AgentRunCancellationControl
        tenantId="tenant-1"
        venueId="venue-1"
        agentRunId="run-1"
        status="FAILED"
        cancelRequestedAt={null}
      />,
    )
    expect(screen.getByText(/failed and cannot accept/)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('keeps a definitive success truthful when best-effort refresh throws', async () => {
    mocks.mutate.mockResolvedValueOnce({
      id: 'run-1',
      status: 'RUNNING',
      cancelRequestedAt: new Date('2026-08-11T20:00:00.000Z'),
      outcome: 'REPLAYED',
    })
    mocks.refresh.mockImplementationOnce(() => {
      throw new Error('Refresh failed')
    })
    renderControl()
    fireEvent.change(screen.getByLabelText('Operator reason'), { target: { value: 'Stop now' } })
    fireEvent.click(screen.getByRole('button', { name: 'Request cancellation' }))
    expect(await screen.findByText('Cancellation was already requested.')).toBeTruthy()
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})
