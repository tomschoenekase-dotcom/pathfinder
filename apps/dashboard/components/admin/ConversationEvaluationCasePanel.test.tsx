/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ mutate: vi.fn(), refresh: vi.fn() }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { prepareConversationEvaluationCase: { mutate: mocks.mutate } },
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

import { ConversationEvaluationCasePanel } from './ConversationEvaluationCasePanel'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const source = {
  id: '11111111-1111-4111-8111-111111111111',
  sessionId: 'session_1',
  category: 'VISITOR_NEGATIVE_FEEDBACK',
  severity: 'INFO',
  summary: 'A visitor marked this answer not helpful.',
  visitorQuestion: 'Can Pat use the north entrance?',
  assistantAnswer: 'Use the staff-only door.',
  createdAt: new Date('2026-08-23T12:00:00.000Z'),
}

describe('ConversationEvaluationCasePanel', () => {
  afterEach(cleanup)
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.mutate.mockResolvedValue({ revision: 2, replayed: false })
  })

  it('renders an honest empty state without a preparation action', () => {
    render(<ConversationEvaluationCasePanel tenantId="tenant_1" venueId="venue_1" insights={[]} />)
    expect(screen.getByText(/No unresolved answer-quality insights/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Prepare immutable case' })).toBeNull()
  })

  it('shows exact evidence but keeps the sanitized case field empty', () => {
    render(
      <ConversationEvaluationCasePanel tenantId="tenant_1" venueId="venue_1" insights={[source]} />,
    )
    expect(screen.getByText(source.visitorQuestion)).toBeTruthy()
    expect(screen.getByText(source.assistantAnswer)).toBeTruthy()
    expect((screen.getByLabelText('Sanitized visitor question') as HTMLTextAreaElement).value).toBe(
      '',
    )
    expect(
      screen.getByRole('link', { name: 'Review full source conversation' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/chatlogs/session_1')
  })

  it('requires redaction confirmation and submits only sanitized rules', async () => {
    render(
      <ConversationEvaluationCasePanel tenantId="tenant_1" venueId="venue_1" insights={[source]} />,
    )
    fireEvent.change(screen.getByLabelText('Sanitized visitor question'), {
      target: { value: 'Where is the accessible entrance?' },
    })
    fireEvent.change(screen.getByLabelText('Acceptable answer phrases'), {
      target: { value: 'north entrance\nramp entrance' },
    })
    fireEvent.change(screen.getByLabelText('Forbidden answer phrases'), {
      target: { value: 'staff-only door' },
    })
    const button = screen.getByRole('button', { name: 'Prepare immutable case' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Confirm evaluation case redaction'))
    fireEvent.click(button)

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      insightId: source.id,
      sanitizedQuestion: 'Where is the accessible entrance?',
      expectation: 'KNOWN_ANSWER',
      acceptablePhrases: ['north entrance', 'ramp entrance'],
      forbiddenPhrases: ['staff-only door'],
      maxWords: 200,
      sanitizationConfirmed: true,
    })
    expect(JSON.stringify(mocks.mutate.mock.calls)).not.toContain('Pat')
    expect(await screen.findByText(/revision 2 created/)).toBeTruthy()
    expect(mocks.refresh).toHaveBeenCalledTimes(1)
  })
})
