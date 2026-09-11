/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { recordSupportReviewedDecline: { mutate } } }),
}))

import { SemanticReviewedDeclineForm } from './SemanticReviewedDeclineForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const props = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  onRecorded: vi.fn(),
  onFrozenChange: vi.fn(),
}

describe('SemanticReviewedDeclineForm', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function complete() {
    fireEvent.change(screen.getByLabelText('Decline review note'), {
      target: { value: ' Evidence does not support this proposed change. ' },
    })
    fireEvent.click(screen.getByLabelText(/I confirm this proposal should be declined/))
  }

  it('requires an explicit note and confirmation and reports a qualified result', async () => {
    mutate.mockResolvedValue({ outcome: 'REVIEWED_DECLINE', replayed: false })
    render(<SemanticReviewedDeclineForm {...props} />)
    const button = screen.getByRole('button', { name: 'Record reviewed decline' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    complete()
    fireEvent.click(button)
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      proposalId: props.proposalId,
      expectedProposalUpdatedAt: props.proposalUpdatedAt,
      resolutionNote: 'Evidence does not support this proposed change.',
    })
    expect(screen.getByText(/No venue content or support fulfillment was changed/)).toBeTruthy()
    expect(props.onRecorded).toHaveBeenCalledOnce()
    expect(props.onFrozenChange).toHaveBeenCalledWith(true)
    expect(props.onFrozenChange).toHaveBeenLastCalledWith(true)
  })

  it('freezes and retries the exact input after an unknown outcome', async () => {
    vi.useFakeTimers()
    mutate
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        outcome: 'REVIEWED_DECLINE',
        replayed: true,
      })
    render(<SemanticReviewedDeclineForm {...props} />)
    complete()
    fireEvent.click(screen.getByRole('button', { name: 'Record reviewed decline' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_001))
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact reviewed decline' }))
    await act(async () => Promise.resolve())
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0])
    expect(props.onFrozenChange).toHaveBeenCalledWith(true)
  })

  it('ignores a late result after the proposal scope changes', async () => {
    let finish!: () => void
    mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ outcome: 'REVIEWED_DECLINE', replayed: false })
        }),
    )
    const view = render(<SemanticReviewedDeclineForm {...props} />)
    complete()
    fireEvent.click(screen.getByRole('button', { name: 'Record reviewed decline' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    view.rerender(<SemanticReviewedDeclineForm {...props} venueId="venue-b" />)
    await act(async () => finish())
    expect(props.onRecorded).not.toHaveBeenCalled()
    expect(screen.queryByText(/support fulfillment was changed/)).toBeNull()
  })
})
