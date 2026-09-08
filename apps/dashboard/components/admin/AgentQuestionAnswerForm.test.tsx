/** @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mutate = vi.fn()
const refresh = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      answerAgentQuestion: { mutate },
      routeAgentQuestionToClient: { mutate: vi.fn() },
    },
  }),
}))

import { AgentQuestionAnswerForm } from './AgentQuestionAnswerForm'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const expectedUpdatedAt = new Date('2026-09-08T12:00:00.000Z')

function renderForm(overrides: Partial<React.ComponentProps<typeof AgentQuestionAnswerForm>> = {}) {
  const props = {
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    questionId: 'question-a',
    expectedUpdatedAt,
    choices: [],
    recipients: [],
    canRouteToClient: false,
    ...overrides,
  }
  const rendered = render(<AgentQuestionAnswerForm {...props} />)
  fireEvent.change(screen.getByLabelText('Your answer'), {
    target: { value: 'Use the greenhouse entrance.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
  return { ...rendered, props }
}

describe('AgentQuestionAnswerForm', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('confirms an answered question whose eligible run was queued without claiming approval', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: true,
      executionTriggered: true,
      dispatchStatus: 'ENQUEUED',
    })
    renderForm()

    expect((await screen.findByRole('status')).textContent).toContain(
      'Answer recorded. The run was queued for its worker to resume. This answer did not approve an action.',
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('distinguishes an eligible run when worker dispatch did not enqueue it', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: true,
      executionTriggered: false,
      dispatchStatus: 'DISABLED',
    })
    renderForm()

    expect((await screen.findByRole('status')).textContent).toContain(
      'The run is eligible to resume when worker dispatch is available.',
    )
    expect(screen.getByRole('status').textContent).toContain(
      'This answer did not approve an action.',
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('confirms a non-resuming response without implying execution or authority', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    renderForm()

    expect((await screen.findByRole('status')).textContent).toContain(
      'Response recorded. No run resumed and no action was approved.',
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('keeps the answer and reports uncertainty when the mutation fails', async () => {
    mutate.mockRejectedValue(new Error('connection closed before acknowledgement'))
    renderForm()

    expect((await screen.findByRole('status')).textContent).toContain(
      'The response could not be confirmed. Refresh before retrying.',
    )
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(
      'Use the greenhouse entrance.',
    )
    expect(refresh).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Answer agent' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    )
  })

  it('freezes and retries the exact recorded response when worker wake-up is unconfirmed', async () => {
    mutate
      .mockResolvedValueOnce({
        runEligibleToResume: true,
        executionTriggered: false,
        dispatchStatus: 'UNCONFIRMED',
      })
      .mockResolvedValueOnce({
        runEligibleToResume: true,
        executionTriggered: true,
        dispatchStatus: 'ENQUEUED',
      })
    renderForm()

    expect((await screen.findByRole('status')).textContent).toContain(
      'Answer recorded, but worker wake-up could not be confirmed.',
    )
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Answer agent' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Dismiss with note' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(refresh).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry worker wake-up' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0])
    expect((await screen.findByRole('status')).textContent).toContain(
      'The run was queued for its worker to resume.',
    )
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('retains the recorded-answer state after a retry transport failure', async () => {
    mutate
      .mockResolvedValueOnce({
        runEligibleToResume: true,
        executionTriggered: false,
        dispatchStatus: 'UNCONFIRMED',
      })
      .mockRejectedValueOnce(new Error('worker dispatch connection closed'))
    renderForm()
    await screen.findByRole('button', { name: 'Retry worker wake-up' })

    fireEvent.click(screen.getByRole('button', { name: 'Retry worker wake-up' }))

    expect((await screen.findByRole('status')).textContent).toContain(
      'The answer is already recorded, but worker wake-up is still unconfirmed.',
    )
    expect(screen.getByRole('button', { name: 'Retry worker wake-up' })).toBeTruthy()
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('removes a stale retry and clears its answer when the question scope or revision changes', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: true,
      executionTriggered: false,
      dispatchStatus: 'UNCONFIRMED',
    })
    const rendered = renderForm()
    await screen.findByRole('button', { name: 'Retry worker wake-up' })

    rendered.rerender(<AgentQuestionAnswerForm {...rendered.props} questionId="question-b" />)
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry worker wake-up' })).toBeNull(),
    )
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('')

    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'New answer.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
    await screen.findByRole('button', { name: 'Retry worker wake-up' })
    rendered.rerender(
      <AgentQuestionAnswerForm
        {...rendered.props}
        questionId="question-b"
        expectedUpdatedAt={new Date('2026-09-08T12:01:00.000Z')}
      />,
    )
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Retry worker wake-up' })).toBeNull(),
    )
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('')
  })

  it('does not let an old-scope completion unlock a new in-flight answer', async () => {
    let resolveOld!: (value: unknown) => void
    let resolveNew!: (value: unknown) => void
    mutate
      .mockImplementationOnce(() => new Promise((resolve) => (resolveOld = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNew = resolve)))
    const rendered = renderForm()
    rendered.rerender(<AgentQuestionAnswerForm {...rendered.props} questionId="question-b" />)
    await waitFor(() =>
      expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(''),
    )
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'New scope answer.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))

    resolveOld({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    await Promise.resolve()
    expect((screen.getByRole('button', { name: 'Recording…' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(document.querySelector('form')?.getAttribute('aria-busy')).toBe('true')

    resolveNew({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    expect((await screen.findByRole('status')).textContent).toContain('Response recorded.')
  })
})
