/* @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConversationLearningProposalDraft } from './ConversationLearningProposalDraft'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const candidate = {
  id: 'candidate-1',
  summary: 'A visitor reported that the east entrance is step-free.',
  reviewerFeedback: 'Confirm this against the current accessibility guide.',
}

function deferred() {
  let resolve!: () => void
  let reject!: (reason: Error) => void
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

afterEach(cleanup)

describe('ConversationLearningProposalDraft', () => {
  it('starts with no proposed fact and states the unverified draft-only boundary', () => {
    render(<ConversationLearningProposalDraft candidate={candidate} onCreate={vi.fn()} />)

    expect(screen.getByText('Prepare proposal draft')).toBeTruthy()
    expect((screen.getByLabelText('Proposed canonical change') as HTMLTextAreaElement).value).toBe(
      '',
    )
    expect((screen.getByLabelText('Evidence-based reason') as HTMLTextAreaElement).value).toBe(
      candidate.reviewerFeedback,
    )
    expect(screen.getByText(/candidate is still unverified/i).textContent).toMatch(
      /does not approve it or update the venue guide/i,
    )
    expect(
      (screen.getByRole('button', { name: 'Create proposal draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })

  it('submits trimmed bounded fields once and reports success without a guide update claim', async () => {
    const pending = deferred()
    const onCreate = vi.fn(() => pending.promise)
    render(<ConversationLearningProposalDraft candidate={candidate} onCreate={onCreate} />)

    fireEvent.change(screen.getByLabelText('Proposed canonical change'), {
      target: { value: '  Add verified step-free entrance guidance.  ' },
    })
    fireEvent.change(screen.getByLabelText('Evidence-based reason'), {
      target: { value: '  Confirmed against the accessibility guide.  ' },
    })
    const submit = screen.getByRole('button', { name: 'Create proposal draft' })
    fireEvent.click(submit)
    fireEvent.submit(submit.closest('form')!)

    expect(onCreate).toHaveBeenCalledOnce()
    expect(onCreate).toHaveBeenCalledWith({
      proposedChange: 'Add verified step-free entrance guidance.',
      reason: 'Confirmed against the accessibility guide.',
    })
    expect(
      (screen.getByRole('button', { name: 'Creating draft…' }) as HTMLButtonElement).disabled,
    ).toBe(true)

    await act(async () => pending.resolve())
    expect((await screen.findByRole('status')).textContent).toMatch(/separate human review/i)
    expect(screen.getByRole('status').textContent).toMatch(/venue knowledge was not changed/i)
  })

  it('keeps both unsaved fields visible when creation fails', async () => {
    const onCreate = vi.fn().mockRejectedValue(new Error('failed'))
    render(<ConversationLearningProposalDraft candidate={candidate} onCreate={onCreate} />)
    fireEvent.change(screen.getByLabelText('Proposed canonical change'), {
      target: { value: 'Keep this proposed change' },
    })
    fireEvent.change(screen.getByLabelText('Evidence-based reason'), {
      target: { value: 'Keep this review reason' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create proposal draft' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/entries are still here/i)
    expect((screen.getByLabelText('Proposed canonical change') as HTMLTextAreaElement).value).toBe(
      'Keep this proposed change',
    )
    expect((screen.getByLabelText('Evidence-based reason') as HTMLTextAreaElement).value).toBe(
      'Keep this review reason',
    )
  })

  it('enforces field bounds and the external disabled state', async () => {
    const onCreate = vi.fn()
    const rendered = render(
      <ConversationLearningProposalDraft candidate={candidate} onCreate={onCreate} />,
    )
    fireEvent.change(screen.getByLabelText('Proposed canonical change'), {
      target: { value: 'x'.repeat(10_001) },
    })
    fireEvent.submit(screen.getByRole('button', { name: 'Create proposal draft' }).closest('form')!)
    await waitFor(() => expect(onCreate).not.toHaveBeenCalled())

    rendered.rerender(
      <ConversationLearningProposalDraft candidate={candidate} onCreate={onCreate} disabled />,
    )
    expect(
      (screen.getByLabelText('Proposed canonical change') as HTMLTextAreaElement).disabled,
    ).toBe(true)
    expect((screen.getByLabelText('Evidence-based reason') as HTMLTextAreaElement).disabled).toBe(
      true,
    )
    expect(
      (screen.getByRole('button', { name: 'Create proposal draft' }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
