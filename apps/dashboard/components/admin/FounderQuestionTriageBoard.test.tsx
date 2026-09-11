/* @vitest-environment jsdom */
import React from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'

import { FounderQuestionTriageBoard } from './FounderQuestionTriageBoard'

vi.mock('./AgentQuestionEvidence', () => ({
  AgentQuestionEvidence: ({ proposedAnswer }: { proposedAnswer: unknown }) => (
    <span>Evidence {JSON.stringify(proposedAnswer)}</span>
  ),
}))
vi.mock('./AgentQuestionDiscussion', () => ({
  AgentQuestionDiscussion: ({
    tenantId,
    venueId,
    questionId,
  }: {
    tenantId: string
    venueId: string
    questionId: string
  }) => (
    <span>
      Discussion {tenantId}/{venueId}/{questionId}
    </span>
  ),
}))
vi.mock('./AgentQuestionAnswerForm', () => ({
  AgentQuestionAnswerForm: ({
    questionId,
    questionType,
  }: {
    questionId: string
    questionType: string
  }) => {
    const [draft, setDraft] = React.useState('')
    return (
      <label>
        Answer controls {questionId} {questionType}
        <input
          aria-label={`Draft answer ${questionId}`}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
    )
  },
}))

const questions = {
  items: [
    {
      id: 'local-question',
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      agentRunId: 'run-1',
      question: 'Are the holiday hours still current?',
      context: 'One dated document conflicts with otherwise usable visitor information.',
      questionType: 'YES_NO' as const,
      category: 'builder-file-clarification',
      urgency: 'NORMAL' as const,
      choices: ['Yes', 'No'],
      dueAt: null,
      evidence: [],
      proposedAnswer: { interpretation: 'Exclude holiday hours' },
      blocking: false,
      createdAt: new Date('2026-08-29T10:00:00.000Z'),
      updatedAt: new Date('2026-08-29T10:00:00.000Z'),
      agentIdentity: { name: 'Venue Builder' },
      venue: { name: 'North Campus' },
      agentRun: {
        id: 'run-1',
        status: 'AWAITING_INPUT' as const,
        requestedOperation: 'file-review',
      },
    },
    {
      id: 'blocking-question',
      tenantId: 'tenant-2',
      venueId: 'venue-2',
      agentRunId: 'run-2',
      question: 'Which building does this source describe?',
      context: 'The venue identity is foundational to every extracted claim.',
      questionType: 'MULTIPLE_CHOICE' as const,
      category: 'builder-identity',
      urgency: 'HIGH' as const,
      choices: ['North building', 'South building'],
      dueAt: new Date('2026-08-30T10:00:00.000Z'),
      evidence: [],
      proposedAnswer: null,
      blocking: true,
      createdAt: new Date('2026-08-29T09:00:00.000Z'),
      updatedAt: new Date('2026-08-29T09:00:00.000Z'),
      agentIdentity: { name: 'Source Analyst' },
      venue: { name: 'West Hall' },
      agentRun: {
        id: 'run-2',
        status: 'AWAITING_INPUT' as const,
        requestedOperation: 'identity-review',
      },
    },
  ],
  nextCursor: { createdAt: '2026-08-29T09:00:00.000Z', id: 'blocking-question' },
}

describe('FounderQuestionTriageBoard', () => {
  it('prioritizes blocking work, filters loaded questions, and expands evidence in place', () => {
    render(
      <FounderQuestionTriageBoard
        questions={questions as never}
        generatedAt={new Date('2026-08-29T12:00:00.000Z')}
      />,
    )

    const summaries = screen.getAllByText(/Which building|holiday hours/i)
    expect(summaries[0]?.textContent).toContain('Which building')
    const blockingCard = screen
      .getByText('Which building does this source describe?')
      .closest('details')
    expect(blockingCard?.hasAttribute('open')).toBe(false)

    fireEvent.click(screen.getByText('Which building does this source describe?'))
    expect(blockingCard?.hasAttribute('open')).toBe(true)
    expect(screen.getByText('Answer controls blocking-question MULTIPLE_CHOICE')).toBeTruthy()
    expect(screen.getByText('Evidence null')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Dependency'), { target: { value: 'LOCAL' } })
    expect(screen.getByText('Are the holiday hours still current?')).toBeTruthy()
    expect(
      screen.getByText('Which building does this source describe?').closest('details')?.hidden,
    ).toBe(true)
    expect(
      screen.getByText(/Showing 1 matching questions from 2 loaded open questions/),
    ).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Find a question'), { target: { value: 'missing' } })
    expect(screen.getByText('No loaded open questions match these filters.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
    expect(screen.getByText('Which building does this source describe?')).toBeTruthy()
  })

  it('places urgent local questions before every nonurgent blocker and keeps nonpriority sorts available', () => {
    const generatedAt = new Date('2026-08-29T12:00:00.000Z')
    const priorityQuestions = {
      items: [
        {
          ...questions.items[0],
          id: 'urgent-local',
          question: 'Urgent local visitor safety clarification',
          urgency: 'URGENT' as const,
          dueAt: generatedAt,
          createdAt: new Date('2026-08-29T08:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'normal-blocking-oldest',
          question: 'Normal blocking source question',
          urgency: 'NORMAL' as const,
          dueAt: new Date('2026-08-29T11:59:59.999Z'),
          createdAt: new Date('2026-08-29T07:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'low-blocking-newest',
          question: 'Low blocking source question',
          urgency: 'LOW' as const,
          dueAt: new Date('2026-08-29T13:00:00.000Z'),
          createdAt: new Date('2026-08-29T11:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'normal-blocking-newer',
          question: 'Normal blocking newer source question',
          urgency: 'NORMAL' as const,
          dueAt: null,
          createdAt: new Date('2026-08-29T10:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'low-blocking-oldest',
          question: 'Low blocking oldest source question',
          urgency: 'LOW' as const,
          dueAt: null,
          createdAt: new Date('2026-08-29T06:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'high-blocking-z',
          question: 'High blocking source question Z',
          urgency: 'HIGH' as const,
          dueAt: null,
          createdAt: new Date('2026-08-29T09:00:00.000Z'),
        },
        {
          ...questions.items[1],
          id: 'high-blocking-a',
          question: 'High blocking source question A',
          urgency: 'HIGH' as const,
          dueAt: null,
          createdAt: new Date('2026-08-29T09:00:00.000Z'),
        },
      ],
      nextCursor: null,
    }
    const { container } = render(
      <FounderQuestionTriageBoard
        questions={priorityQuestions as never}
        generatedAt={generatedAt}
      />,
    )

    const summaries = Array.from(container.querySelectorAll('details > summary')).map(
      (summary) => summary.textContent,
    )
    expect(summaries[0]).toContain('Urgent local visitor safety clarification')
    expect(summaries[1]).toContain('High blocking source question A')
    expect(summaries[2]).toContain('High blocking source question Z')
    expect(summaries[3]).toContain('Normal blocking source question')
    expect(summaries[4]).toContain('Normal blocking newer source question')
    expect(summaries[5]).toContain('Low blocking oldest source question')
    expect(summaries[6]).toContain('Low blocking source question')
    expect(screen.getByText('Due now', { exact: true })).toBeTruthy()
    expect(screen.getByText('Overdue', { exact: true })).toBeTruthy()
    expect(screen.getByText('Due in 1h', { exact: true })).toBeTruthy()

    fireEvent.change(within(container).getByLabelText('Order'), { target: { value: 'NEWEST' } })
    expect(container.querySelector('details > summary')?.textContent).toContain(
      'Low blocking source question',
    )
    fireEvent.change(within(container).getByLabelText('Order'), { target: { value: 'OLDEST' } })
    expect(container.querySelector('details > summary')?.textContent).toContain(
      'Low blocking oldest source question',
    )
  })

  it('groups only the exact tenant, venue, and workflow identity after filtering', () => {
    const groupedQuestions = {
      items: [
        {
          ...questions.items[0],
          id: 'urgent-shared-one',
          question: 'Urgent shared workflow question',
          urgency: 'URGENT' as const,
          agentRunId: 'same-run-id',
          agentRun: {
            id: 'same-run-id',
            status: 'AWAITING_INPUT' as const,
            requestedOperation: 'urgent-review',
          },
          venue: { name: 'North Campus' },
        },
        {
          ...questions.items[0],
          id: 'urgent-shared-two',
          question: 'Second shared workflow question',
          urgency: 'HIGH' as const,
          agentRunId: 'same-run-id',
          agentRun: {
            id: 'same-run-id',
            status: 'AWAITING_INPUT' as const,
            requestedOperation: 'urgent-review',
          },
          venue: { name: 'North Campus' },
        },
        {
          ...questions.items[1],
          id: 'same-run-other-venue',
          question: 'Same run string, another venue',
          tenantId: 'tenant-1',
          venueId: 'venue-2',
          agentRunId: 'same-run-id',
          agentRun: {
            id: 'same-run-id',
            status: 'AWAITING_INPUT' as const,
            requestedOperation: 'venue-isolated-review',
          },
          venue: { name: 'South Campus' },
        },
        {
          ...questions.items[1],
          id: 'same-run-other-tenant',
          question: 'Same run string, another tenant',
          tenantId: 'tenant-2',
          venueId: 'venue-1',
          agentRunId: 'same-run-id',
          agentRun: {
            id: 'same-run-id',
            status: 'AWAITING_INPUT' as const,
            requestedOperation: 'tenant-isolated-review',
          },
          venue: { name: 'East Campus' },
        },
        {
          ...questions.items[0],
          id: 'runless-one',
          question: 'Runless question one',
          agentRunId: null,
          agentRun: null,
        },
        {
          ...questions.items[0],
          id: 'runless-two',
          question: 'Runless question two',
          agentRunId: null,
          agentRun: null,
        },
      ],
      nextCursor: null,
    }
    const { container } = render(
      <FounderQuestionTriageBoard
        questions={groupedQuestions as never}
        generatedAt={new Date('2026-08-29T12:00:00.000Z')}
      />,
    )
    const board = within(container)

    expect((board.getByLabelText('Individual questions') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(board.getByLabelText('Group by workflow'))
    const headings = Array.from(container.querySelectorAll('[data-workflow-group]'))
    expect(headings).toHaveLength(3)
    expect(headings[0]?.textContent).toContain('urgent review')
    const summaries = Array.from(container.querySelectorAll('details > summary')).map(
      (summary) => summary.textContent,
    )
    expect(summaries[0]).toContain('Urgent shared workflow question')
    expect(summaries[1]).toContain('Second shared workflow question')
    expect(board.getByText('2 matching loaded questions in this workflow.')).toBeTruthy()
    const workflowLinks = board.getAllByRole('link', { name: 'Open workflow' })
    expect(workflowLinks).toHaveLength(3)
    expect(workflowLinks[0]?.getAttribute('href')).toBe(
      '/admin/clients/tenant-1/venues/venue-1/agents/runs/same-run-id',
    )
    expect(board.getByText('Runless question one')).toBeTruthy()
    expect(container.querySelectorAll('[data-independent-question]')).toHaveLength(2)
    expect(board.getByLabelText('Draft answer runless-one')).toBeTruthy()
    expect(board.getByLabelText('Draft answer runless-two')).toBeTruthy()
    expect(board.getAllByText(/Answer controls /)).toHaveLength(6)

    fireEvent.change(board.getByLabelText('Find a question'), {
      target: { value: 'Second shared workflow' },
    })
    expect(container.querySelectorAll('[data-workflow-group]')).toHaveLength(1)
    expect(board.getByText('1 matching loaded question in this workflow.')).toBeTruthy()
    expect(board.getByText('Urgent shared workflow question').closest('details')?.hidden).toBe(true)
  })

  it('preserves an open draft through filters, an empty result, and display grouping', () => {
    const { container, rerender } = render(
      <FounderQuestionTriageBoard
        questions={questions as never}
        generatedAt={new Date('2026-08-29T12:00:00.000Z')}
      />,
    )
    const board = within(container)

    const draft = board.getByLabelText('Draft answer local-question')
    fireEvent.change(draft, { target: { value: 'Keep this answer draft.' } })
    const card = board.getByText('Are the holiday hours still current?').closest('details')
    fireEvent.click((card as HTMLElement).querySelector('summary') as HTMLElement)
    expect(card?.open).toBe(true)

    fireEvent.change(board.getByLabelText('Find a question'), { target: { value: 'West Hall' } })
    const filteredCard = container
      .querySelector('[aria-label="Draft answer local-question"]')
      ?.closest('details')
    expect(filteredCard).toBe(card)
    expect(filteredCard?.hidden).toBe(true)
    expect(board.queryByRole('textbox', { name: 'Draft answer local-question' })).toBeNull()
    expect(
      (container.querySelector('[aria-label="Draft answer local-question"]') as HTMLInputElement)
        .value,
    ).toBe('Keep this answer draft.')
    fireEvent.change(board.getByLabelText('Find a question'), { target: { value: 'no-match' } })
    expect(screen.getByText('No loaded open questions match these filters.')).toBeTruthy()
    expect(
      container.querySelector('[aria-label="Draft answer local-question"]')?.closest('details'),
    ).toBe(card)
    expect(card?.hidden).toBe(true)

    fireEvent.click(board.getByRole('button', { name: 'Clear filters' }))
    expect(card?.open).toBe(true)
    expect((board.getByLabelText('Draft answer local-question') as HTMLInputElement).value).toBe(
      'Keep this answer draft.',
    )
    fireEvent.click(board.getByLabelText('Group by workflow'))
    expect((board.getByLabelText('Draft answer local-question') as HTMLInputElement).value).toBe(
      'Keep this answer draft.',
    )
    fireEvent.click(board.getByLabelText('Individual questions'))
    expect((board.getByLabelText('Draft answer local-question') as HTMLInputElement).value).toBe(
      'Keep this answer draft.',
    )

    rerender(
      <FounderQuestionTriageBoard
        questions={{ ...questions, items: [questions.items[1]] } as never}
        generatedAt={new Date('2026-08-29T12:00:00.000Z')}
      />,
    )
    expect(container.querySelector('[aria-label="Draft answer local-question"]')).toBeNull()

    rerender(
      <FounderQuestionTriageBoard
        questions={
          {
            ...questions,
            items: [
              questions.items[1],
              { ...questions.items[0], updatedAt: new Date('2026-08-29T12:05:00.000Z') },
            ],
          } as never
        }
        generatedAt={new Date('2026-08-29T12:05:00.000Z')}
      />,
    )
    expect((board.getByLabelText('Draft answer local-question') as HTMLInputElement).value).toBe('')
  })

  it('has no automated accessibility violations in its collapsed triage state', async () => {
    const { container } = render(
      <FounderQuestionTriageBoard
        questions={questions as never}
        generatedAt={new Date('2026-08-29T12:00:00.000Z')}
      />,
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
