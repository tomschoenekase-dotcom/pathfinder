/* @vitest-environment jsdom */
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { describe, expect, it, vi } from 'vitest'

import { FounderQuestionTriageBoard } from './FounderQuestionTriageBoard'

vi.mock('./AgentQuestionEvidence', () => ({
  AgentQuestionEvidence: ({ proposedAnswer }: { proposedAnswer: unknown }) => (
    <span>Evidence {JSON.stringify(proposedAnswer)}</span>
  ),
}))
vi.mock('./AgentQuestionAnswerForm', () => ({
  AgentQuestionAnswerForm: ({ questionId }: { questionId: string }) => (
    <span>Answer controls {questionId}</span>
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
    expect(screen.getByText('Answer controls blocking-question')).toBeTruthy()
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
