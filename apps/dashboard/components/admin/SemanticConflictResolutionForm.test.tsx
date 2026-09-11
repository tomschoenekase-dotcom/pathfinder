/* @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  client: { admin: { resolveSemanticConflict: { mutate: vi.fn() } } },
}))
mocks.client.admin.resolveSemanticConflict.mutate = mocks.mutate
vi.mock('../../lib/trpc', () => ({ useTRPCClient: () => mocks.client }))

import { SemanticConflictResolutionForm } from './SemanticConflictResolutionForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const desired = {
  title: 'Gallery hours',
  category: 'Hours',
  content: 'The gallery closes at 7 PM.',
  isEnabled: true,
}
const baseProps = {
  tenantId: 'tenant-1',
  venueId: 'venue-1',
  proposalId: '11111111-1111-4111-8111-111111111111',
  proposalUpdatedAt: '2026-09-10T12:00:00.000Z',
  previewHash: 'a'.repeat(64),
  relation: 'CORRECTS' as const,
  desired,
  question: {
    id: 'question-1',
    answer: 'Use the signed hours sheet.',
    updatedAt: '2026-09-10T12:01:00.000Z',
    answeredAt: '2026-09-10T12:01:00.000Z',
    answerHash: 'b'.repeat(64),
  },
  onResolved: vi.fn(),
  onRefresh: vi.fn(),
  onFrozenChange: vi.fn(),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => (resolve = next))
  return { promise, resolve }
}

function completeNote() {
  fireEvent.change(screen.getByLabelText('Resolution note'), {
    target: { value: 'Record the operator decision without granting publication authority.' },
  })
}

describe('SemanticConflictResolutionForm', () => {
  beforeEach(() => {
    mocks.mutate.mockReset()
    baseProps.onResolved.mockReset()
    baseProps.onRefresh.mockReset()
    baseProps.onFrozenChange.mockReset()
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    )
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('requires an explicit choice and sends keep or edited replacement content exactly', async () => {
    mocks.mutate.mockResolvedValue({
      resolutionId: 'resolution-1',
      replacementProposalId: null,
      outcome: 'KEEP_CANONICAL',
    })
    const view = render(<SemanticConflictResolutionForm {...baseProps} />)
    expect(screen.getByText(/Use the signed hours sheet/)).toBeTruthy()
    expect(
      (screen.getByRole('button', { name: 'Record resolution' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByLabelText(/Keep current guidance/))
    completeNote()
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate.mock.calls[0]![0]).toMatchObject({
      outcome: 'KEEP_CANONICAL',
      desired,
      expectedAnswerHash: baseProps.question.answerHash,
    })
    expect(mocks.mutate.mock.calls[0]![0]).not.toHaveProperty('replacementDesired')

    view.unmount()
    mocks.mutate.mockResolvedValue({
      resolutionId: 'resolution-2',
      replacementProposalId: 'proposal-2',
      outcome: 'PROPOSE_REPLACEMENT',
    })
    render(<SemanticConflictResolutionForm {...baseProps} />)
    fireEvent.click(screen.getByLabelText(/Propose replacement/))
    fireEvent.change(screen.getByLabelText('Replacement content'), {
      target: { value: 'The gallery closes at 6 PM.' },
    })
    completeNote()
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.mutate.mock.calls[1]![0]).toMatchObject({
      outcome: 'PROPOSE_REPLACEMENT',
      replacementDesired: { ...desired, content: 'The gallery closes at 6 PM.' },
    })
    expect((await screen.findByRole('status')).textContent).toMatch(/separate human review/i)
  })

  it('freezes controls synchronously and prevents duplicate submission', async () => {
    const pending = deferred<never>()
    mocks.mutate.mockReturnValue(pending.promise)
    render(<SemanticConflictResolutionForm {...baseProps} />)
    fireEvent.click(screen.getByLabelText(/Keep current guidance/))
    completeNote()
    const submit = screen.getByRole('button', { name: 'Record resolution' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(baseProps.onFrozenChange).toHaveBeenLastCalledWith(true)
    expect((screen.getByRole('group') as HTMLFieldSetElement).disabled).toBe(true)
  })

  it('retains the exact operation and payload after timeout for an explicit retry', async () => {
    vi.useFakeTimers()
    mocks.mutate
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce({
        resolutionId: 'resolution-1',
        replacementProposalId: null,
        outcome: 'KEEP_CANONICAL',
      })
    render(<SemanticConflictResolutionForm {...baseProps} />)
    fireEvent.click(screen.getByLabelText(/Keep current guidance/))
    completeNote()
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    await act(async () => {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(screen.getByText(/outcome is unknown/i)).toBeTruthy()
    const firstPayload = mocks.mutate.mock.calls[0]![0]
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact resolution' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.mutate).toHaveBeenCalledTimes(2)
    expect(mocks.mutate.mock.calls[1]![0]).toEqual(firstPayload)
    expect(baseProps.onResolved).toHaveBeenCalledWith(
      expect.objectContaining({ resolutionId: 'resolution-1' }),
    )
  })

  it('ignores a late completion after the semantic scope changes', async () => {
    const pending = deferred<{
      resolutionId: string
      replacementProposalId: null
      outcome: string
    }>()
    mocks.mutate.mockReturnValueOnce(pending.promise)
    const view = render(<SemanticConflictResolutionForm {...baseProps} />)
    fireEvent.click(screen.getByLabelText(/Keep current guidance/))
    completeNote()
    fireEvent.click(screen.getByRole('button', { name: 'Record resolution' }))
    view.rerender(
      <SemanticConflictResolutionForm
        {...baseProps}
        previewHash={'c'.repeat(64)}
        question={{ ...baseProps.question, updatedAt: '2026-09-10T12:02:00.000Z' }}
      />,
    )
    pending.resolve({
      resolutionId: 'stale-resolution',
      replacementProposalId: null,
      outcome: 'KEEP_CANONICAL',
    })
    await Promise.resolve()
    expect(baseProps.onResolved).not.toHaveBeenCalled()
    expect(screen.queryByText(/Current venue guidance kept/)).toBeNull()
  })
})
