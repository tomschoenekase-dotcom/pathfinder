/** @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const mutation = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      answerAgentQuestion: { mutate: mutation },
      routeAgentQuestionToClient: { mutate: mutation },
      listAgentQuestionDiscussion: { query: vi.fn() },
    },
  }),
}))

import { FounderQuestionTriageBoard } from './FounderQuestionTriageBoard'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

afterEach(cleanup)

it('retains the real answer form through hidden filters but resets a changed server revision', () => {
  const now = new Date('2026-09-08T12:00:00Z')
  const question: React.ComponentProps<
    typeof FounderQuestionTriageBoard
  >['questions']['items'][number] = {
    id: 'north-question',
    tenantId: 'tenant-north',
    venueId: 'venue-north',
    venue: { name: 'North Gallery' },
    agentRunId: 'run-north',
    agentRun: { id: 'run-north', status: 'AWAITING_INPUT', requestedOperation: 'arrival-review' },
    question: 'Confirm the entrance?',
    context: null,
    questionType: 'YES_NO',
    category: 'general',
    urgency: 'URGENT',
    choices: ['Confirm', 'Keep pending'],
    dueAt: null,
    expiresAt: null,
    evidence: [],
    proposedAnswer: null,
    blocking: true,
    createdAt: now,
    updatedAt: now,
    agentIdentity: { name: 'Operations analyst' },
  }
  const other = {
    ...question,
    id: 'south-question',
    tenantId: 'tenant-south',
    venueId: 'venue-south',
    venue: { name: 'South Museum' },
    agentRunId: 'run-south',
    agentRun: {
      id: 'run-south',
      status: 'AWAITING_INPUT' as const,
      requestedOperation: 'arrival-review',
    },
    question: 'Confirm the gallery?',
  }
  const props = { questions: { items: [question, other], nextCursor: null }, generatedAt: now }
  const { container, rerender } = render(<FounderQuestionTriageBoard {...props} />)
  const board = within(container)
  const card = board.getByText(question.question).closest('details')!
  fireEvent.click(card.querySelector('summary')!)
  const answer = within(card).getByLabelText('Your answer') as HTMLTextAreaElement
  fireEvent.change(answer, { target: { value: 'Keep the north entrance staffed.' } })
  for (const filter of ['South Museum', 'nothing matches']) {
    fireEvent.change(board.getByLabelText('Find a question'), { target: { value: filter } })
    expect(card.isConnected).toBe(true)
    expect(card.hidden).toBe(true)
    expect(answer.value).toBe('Keep the north entrance staffed.')
  }
  fireEvent.click(board.getByRole('button', { name: 'Clear filters' }))
  expect(card.hidden).toBe(false)
  expect(card.open).toBe(true)
  expect(within(card).getByLabelText('Your answer')).toBe(answer)
  expect(answer.value).toBe('Keep the north entrance staffed.')

  fireEvent.change(board.getByLabelText('Find a question'), { target: { value: 'South Museum' } })
  rerender(
    <FounderQuestionTriageBoard
      {...props}
      questions={{
        items: [{ ...question, updatedAt: new Date('2026-09-08T12:01:00Z') }, other],
        nextCursor: null,
      }}
    />,
  )
  fireEvent.click(board.getByRole('button', { name: 'Clear filters' }))
  expect(answer.value).toBe('')
  expect(mutation).not.toHaveBeenCalled()
})
