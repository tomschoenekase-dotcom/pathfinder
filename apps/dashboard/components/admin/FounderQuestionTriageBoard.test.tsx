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
vi.mock('./AgentQuestionAnswerForm', () => ({
  AgentQuestionAnswerForm: ({
    questionId,
    questionType,
  }: {
    questionId: string
    questionType: string
  }) => (
    <span>
      Answer controls {questionId} {questionType}
    </span>
  ),
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
    expect(screen.queryByText('Which building does this source describe?')).toBeNull()
    expect(screen.getByText(/Showing 1 of 2 loaded open questions/)).toBeTruthy()

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
