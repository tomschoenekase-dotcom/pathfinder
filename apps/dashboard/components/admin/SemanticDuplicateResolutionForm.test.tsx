/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { resolveSupportSemanticDuplicate: { mutate } } }),
}))

import { SemanticDuplicateResolutionForm } from './SemanticDuplicateResolutionForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const props = {
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  previewHash: 'a'.repeat(64),
  relation: 'NEW_FACT' as const,
  desired: {
    title: 'Visitor assistance',
    category: 'Services',
    content: 'Visitor assistance is available at the welcome desk.',
    isEnabled: true,
  },
  onResolved: vi.fn(),
  onRefresh: vi.fn(),
  onFrozenChange: vi.fn(),
}

describe('SemanticDuplicateResolutionForm', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('requires an explicit note and confirmation before recording', async () => {
    mutate.mockResolvedValue({ outcome: 'DUPLICATE_NOOP', replayed: false })
    render(<SemanticDuplicateResolutionForm {...props} />)
    const submit = screen.getByRole('button', { name: 'Record duplicate review' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: ' Matches the currently published visitor guidance. ' },
    })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText(/I confirm the proposal duplicates/))
    fireEvent.click(submit)
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      expectedPreviewHash: 'a'.repeat(64),
      relation: 'NEW_FACT',
      desired: props.desired,
      resolutionNote: 'Matches the currently published visitor guidance.',
    })
    expect(props.onFrozenChange).toHaveBeenCalledWith(true)
    expect(props.onFrozenChange).toHaveBeenLastCalledWith(false)
    expect(screen.getByText(/No venue content was changed/)).toBeTruthy()
  })

  it('retries the exact frozen input after an unknown outcome', async () => {
    vi.useFakeTimers()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )
    mutate
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({
        outcome: 'DUPLICATE_NOOP',
        replayed: true,
      })
    render(<SemanticDuplicateResolutionForm {...props} />)
    fireEvent.change(screen.getByLabelText('Review note'), {
      target: { value: 'Exact duplicate.' },
    })
    fireEvent.click(screen.getByLabelText(/I confirm the proposal duplicates/))
    fireEvent.click(screen.getByRole('button', { name: 'Record duplicate review' }))
    await act(async () => vi.advanceTimersByTimeAsync(15_001))
    expect(screen.getByRole('button', { name: 'Retry exact duplicate review' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact duplicate review' }))
    await act(async () => Promise.resolve())
    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0])
  })

  it('requires refresh after a known stale-preview rejection', async () => {
    mutate.mockRejectedValue({ data: { code: 'CONFLICT' } })
    render(<SemanticDuplicateResolutionForm {...props} />)
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'Duplicate.' } })
    fireEvent.click(screen.getByLabelText(/I confirm the proposal duplicates/))
    fireEvent.click(screen.getByRole('button', { name: 'Record duplicate review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh duplicate preview' }))
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Retry exact duplicate review' })).toBeNull()
  })

  it('ignores a late result after the scope changes', async () => {
    let resolveRequest!: () => void
    mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = () => resolve({ outcome: 'DUPLICATE_NOOP', replayed: false })
        }),
    )
    const view = render(<SemanticDuplicateResolutionForm {...props} />)
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'Duplicate.' } })
    fireEvent.click(screen.getByLabelText(/I confirm the proposal duplicates/))
    fireEvent.click(screen.getByRole('button', { name: 'Record duplicate review' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1))
    view.rerender(<SemanticDuplicateResolutionForm {...props} venueId="venue-b" />)
    await act(async () => resolveRequest())
    expect(props.onResolved).not.toHaveBeenCalled()
    expect(screen.queryByText(/No venue content was changed/)).toBeNull()
  })
})
