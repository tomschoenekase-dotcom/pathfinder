/** @vitest-environment jsdom */

import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    questionType: 'SHORT_TEXT' as const,
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
    window.sessionStorage.clear()
    vi.useRealTimers()
    vi.clearAllMocks()
  })
  it('closes an open response form at its cutoff and retains the exact run recovery link', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="question-a"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="SHORT_TEXT"
        choices={[]}
        recipients={[]}
        canRouteToClient={false}
        agentRunId="run-a"
        expiresAt={new Date('2026-09-08T12:00:01Z')}
      />,
    )
    expect(screen.getByLabelText('Your answer')).toBeTruthy()
    await act(async () => {
      vi.advanceTimersByTime(1001)
    })
    expect(screen.queryByLabelText('Your answer')).toBeNull()
    expect(screen.getByText('Response window closed')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open linked run' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/agents/runs/run-a',
    )
    expect(mutate).not.toHaveBeenCalled()
  })

  it('clears an actor-scoped session draft when its response window closes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
    render(
      <AgentQuestionAnswerForm
        actorId="founder-a"
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="expiry-question"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="SHORT_TEXT"
        choices={[]}
        recipients={[]}
        canRouteToClient={false}
        expiresAt={new Date('2026-09-08T12:00:01Z')}
      />,
    )
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Draft to expire.' },
    })
    await act(async () => Promise.resolve())
    expect(window.sessionStorage.length).toBe(1)

    await act(async () => {
      vi.advanceTimersByTime(1_001)
    })
    expect(screen.queryByLabelText('Your answer')).toBeNull()
    expect(window.sessionStorage.length).toBe(0)
  })

  it('does not persist drafts when the authenticated actor is unavailable', async () => {
    const first = render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="no-actor-question"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="SHORT_TEXT"
        choices={[]}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Local only.' } })
    await act(async () => Promise.resolve())
    expect(window.sessionStorage.length).toBe(0)
    first.unmount()

    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="no-actor-question"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="SHORT_TEXT"
        choices={[]}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('')
  })
  it('turns a server-confirmed expiry into recovery guidance rather than an ambiguous retry', async () => {
    mutate.mockRejectedValue({ data: { code: 'PRECONDITION_FAILED' } })
    renderForm()
    await waitFor(() => expect(screen.getByText('Response window closed')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Answer agent' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Start a new task' }).getAttribute('href')).toBe(
      '/admin/clients/tenant-a/venues/venue-a/agents#new-task',
    )
    expect(refresh).toHaveBeenCalledOnce()
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

  it('keeps a saved response retry reachable after its response cutoff', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-08T12:00:00Z'))
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
    renderForm({ expiresAt: new Date('2026-09-08T12:00:01Z') })
    await act(async () => Promise.resolve())
    const frozenPayload = mutate.mock.calls[0]?.[0]
    expect(screen.getByRole('button', { name: 'Retry worker wake-up' })).toBeTruthy()

    await act(async () => {
      vi.advanceTimersByTime(1001)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry worker wake-up' }))
    await act(async () => Promise.resolve())

    expect(mutate).toHaveBeenCalledTimes(2)
    expect(mutate.mock.calls[1]?.[0]).toEqual(frozenPayload)
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

  it('provides explicit yes/no suggestions when the question has no supplied choices', () => {
    renderForm({ questionType: 'YES_NO' })
    expect(screen.getByRole('button', { name: 'Yes' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'No' })).toBeTruthy()
  })

  it('toggles multi-select choices and serializes them in supplied order with context', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="multi-a"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="MULTI_SELECT"
        choices={['Ramp access', 'Quiet room', 'Large print']}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Large print' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ramp access' }))
    fireEvent.click(screen.getByRole('button', { name: 'Large print' }))
    fireEvent.click(screen.getByRole('button', { name: 'Large print' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: '  Confirmed in the greenhouse walkthrough.  ' },
    })
    expect(screen.getByRole('button', { name: 'Ramp access' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      answer:
        'Selected: Ramp access; Large print\nContext: Confirmed in the greenhouse walkthrough.',
    })
  })

  it('labels approval/reject responses as guidance without granting action authority', () => {
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="approval-a"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="APPROVAL_REJECT"
        choices={['Recommend approval', 'Recommend rejection']}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    expect(screen.getByText(/Any action approval is a separate explicit step/)).toBeTruthy()
  })

  it('refuses a multi-select payload whose serialized choices and context exceed the API limit', () => {
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="multi-long"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="MULTI_SELECT"
        choices={['Ramp access']}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Ramp access' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: 'A'.repeat(5_000) },
    })
    expect(screen.getByRole('alert').textContent).toContain('must fit within 5,000 characters')
    expect(
      (screen.getByRole('button', { name: 'Answer agent' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    expect(mutate).not.toHaveBeenCalled()
  })

  it('replaces the first multiple-choice selection with the second in the submitted payload', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="single-choice"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="MULTIPLE_CHOICE"
        choices={['North Campus', 'South Campus']}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'North Campus' }))
    fireEvent.click(screen.getByRole('button', { name: 'South Campus' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))

    await waitFor(() => expect(mutate).toHaveBeenCalledOnce())
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({ answer: 'South Campus' })
  })

  it('freezes multi-select choices and context while retrying the exact serialized payload', async () => {
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
    render(
      <AgentQuestionAnswerForm
        tenantId="tenant-a"
        venueId="venue-a"
        questionId="multi-retry"
        expectedUpdatedAt={expectedUpdatedAt}
        questionType="MULTI_SELECT"
        choices={['Ramp access', 'Large print']}
        recipients={[]}
        canRouteToClient={false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Large print' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ramp access' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: 'Confirmed by the founder.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
    await screen.findByRole('button', { name: 'Retry worker wake-up' })

    expect((screen.getByLabelText('Optional context') as HTMLTextAreaElement).disabled).toBe(true)
    expect(
      (screen.getByRole('button', { name: 'Ramp access' }) as HTMLButtonElement).disabled,
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Retry worker wake-up' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[0]?.[0]).toMatchObject({
      answer: 'Selected: Ramp access; Large print\nContext: Confirmed by the founder.',
    })
    expect(mutate.mock.calls[1]?.[0]).toEqual(mutate.mock.calls[0]?.[0])
  })

  it('clears multi-select choices and context when the question or revision changes', async () => {
    const props = {
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      questionId: 'multi-scope-a',
      expectedUpdatedAt,
      questionType: 'MULTI_SELECT' as const,
      choices: ['Ramp access', 'Large print'],
      recipients: [],
      canRouteToClient: false,
    }
    const rendered = render(<AgentQuestionAnswerForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ramp access' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: 'Old scope context.' },
    })

    rendered.rerender(<AgentQuestionAnswerForm {...props} questionId="multi-scope-b" />)
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Ramp access' }).getAttribute('aria-pressed')).toBe(
        'false',
      ),
    )
    expect((screen.getByLabelText('Optional context') as HTMLTextAreaElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Large print' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: 'Old revision context.' },
    })
    rendered.rerender(
      <AgentQuestionAnswerForm
        {...props}
        questionId="multi-scope-b"
        expectedUpdatedAt={new Date('2026-09-08T12:01:00.000Z')}
      />,
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Large print' }).getAttribute('aria-pressed')).toBe(
        'false',
      ),
    )
    expect((screen.getByLabelText('Optional context') as HTMLTextAreaElement).value).toBe('')
  })

  it('restores a scoped answer and multi-select context after reload under StrictMode', async () => {
    const props = {
      actorId: 'founder-a',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      questionId: 'reload-question',
      expectedUpdatedAt,
      questionType: 'MULTI_SELECT' as const,
      choices: ['Ramp access', 'Large print'],
      recipients: [],
      canRouteToClient: false,
    }
    const first = render(<AgentQuestionAnswerForm {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Ramp access' }))
    fireEvent.change(screen.getByLabelText('Optional context'), {
      target: { value: 'Use the north entrance for the ramp.' },
    })
    await waitFor(() => expect(window.sessionStorage.length).toBe(1))
    first.unmount()

    render(
      <React.StrictMode>
        <AgentQuestionAnswerForm {...props} />
      </React.StrictMode>,
    )

    expect(screen.getByText('Draft restored in this browser session.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Ramp access' }).getAttribute('aria-pressed')).toBe(
      'true',
    )
    expect((screen.getByLabelText('Optional context') as HTMLTextAreaElement).value).toBe(
      'Use the north entrance for the ramp.',
    )
  })

  it('does not restore a different actor or a stale question revision', async () => {
    const props = {
      actorId: 'founder-a',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      questionId: 'revision-question',
      expectedUpdatedAt,
      questionType: 'SHORT_TEXT' as const,
      choices: [],
      recipients: [],
      canRouteToClient: false,
    }
    const rendered = render(<AgentQuestionAnswerForm {...props} />)
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Original answer.' },
    })
    await waitFor(() => expect(window.sessionStorage.length).toBe(1))

    rendered.rerender(<AgentQuestionAnswerForm {...props} actorId="founder-b" />)
    await waitFor(() =>
      expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(''),
    )
    rendered.rerender(
      <AgentQuestionAnswerForm
        {...props}
        expectedUpdatedAt={new Date('2026-09-08T12:01:00.000Z')}
      />,
    )
    await waitFor(() =>
      expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe(''),
    )
    expect(screen.queryByText('Draft restored in this browser session.')).toBeNull()
  })

  it('clears a session draft only after a confirmed answer response', async () => {
    mutate.mockResolvedValue({
      runEligibleToResume: false,
      executionTriggered: false,
      dispatchStatus: 'NOT_NEEDED',
    })
    const props = {
      actorId: 'founder-a',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      questionId: 'saved-question',
      expectedUpdatedAt,
      questionType: 'SHORT_TEXT' as const,
      choices: [],
      recipients: [],
      canRouteToClient: false,
    }
    const first = render(<AgentQuestionAnswerForm {...props} />)
    fireEvent.change(screen.getByLabelText('Your answer'), { target: { value: 'Saved response.' } })
    await waitFor(() => expect(window.sessionStorage.length).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
    await screen.findByRole('status')
    expect(window.sessionStorage.length).toBe(0)
    first.rerender(
      <AgentQuestionAnswerForm
        {...props}
        expectedUpdatedAt={new Date('2026-09-08T12:00:00.000Z')}
      />,
    )
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))
    first.unmount()

    render(<AgentQuestionAnswerForm {...props} />)
    expect((screen.getByLabelText('Your answer') as HTMLTextAreaElement).value).toBe('')
  })

  it('does not resurrect a draft after a recorded wake-up retry succeeds', async () => {
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
    const props = {
      actorId: 'founder-a',
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      questionId: 'wakeup-question',
      expectedUpdatedAt,
      questionType: 'SHORT_TEXT' as const,
      choices: [],
      recipients: [],
      canRouteToClient: false,
    }
    const rendered = render(<AgentQuestionAnswerForm {...props} />)
    fireEvent.change(screen.getByLabelText('Your answer'), {
      target: { value: 'Recorded answer.' },
    })
    await waitFor(() => expect(window.sessionStorage.length).toBe(1))
    fireEvent.click(screen.getByRole('button', { name: 'Answer agent' }))
    await screen.findByRole('button', { name: 'Retry worker wake-up' })
    expect(window.sessionStorage.length).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Retry worker wake-up' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    rendered.rerender(
      <AgentQuestionAnswerForm
        {...props}
        expectedUpdatedAt={new Date('2026-09-08T12:00:00.000Z')}
      />,
    )
    await waitFor(() => expect(window.sessionStorage.length).toBe(0))
  })
})
