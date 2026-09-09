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

const rejected = {
  id: '22222222-2222-4222-8222-222222222222',
  category: 'CONTENT_UPDATE_CANDIDATE' as const,
  summary: 'A visitor reported a possible second-floor label mismatch.',
  reviewerFeedback: 'Dismissed until the source signage is checked.',
  candidateRevision: 3,
  reviewedAt: new Date('2026-09-08T12:00:00.000Z'),
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

  it('keeps rejected candidates sanitized and sends only their revision fence', async () => {
    render(
      <ConversationEvaluationCasePanel
        tenantId="tenant_1"
        venueId="venue_1"
        insights={[]}
        rejectedCandidates={[rejected]}
      />,
    )
    expect(screen.getByText(rejected.summary)).toBeTruthy()
    expect(screen.getByText(rejected.reviewerFeedback)).toBeTruthy()
    expect(screen.getByText('Dismissed')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Review full source conversation' })).toBeNull()
    expect((screen.getByLabelText('Sanitized visitor question') as HTMLTextAreaElement).value).toBe(
      '',
    )
    expect((screen.getByLabelText('Acceptable answer phrases') as HTMLTextAreaElement).value).toBe(
      '',
    )

    fireEvent.change(screen.getByLabelText('Sanitized visitor question'), {
      target: { value: 'Where is the second-floor gallery?' },
    })
    fireEvent.change(screen.getByLabelText('Acceptable answer phrases'), {
      target: { value: 'Ask the visitor desk' },
    })
    fireEvent.click(screen.getByLabelText('Confirm evaluation case redaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable case' }))

    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))
    expect(mocks.mutate).toHaveBeenCalledWith({
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      insightId: rejected.id,
      sanitizedQuestion: 'Where is the second-floor gallery?',
      expectation: 'KNOWN_ANSWER',
      acceptablePhrases: ['Ask the visitor desk'],
      forbiddenPhrases: [],
      maxWords: 200,
      sanitizationConfirmed: true,
      expectedCandidateRevision: 3,
    })
    expect(JSON.stringify(mocks.mutate.mock.calls)).not.toContain('Dismissed until')
  })

  it('fences a deferred result after the tenant and source change', async () => {
    let resolveMutation!: (value: { revision: number; replayed: boolean }) => void
    mocks.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }),
    )
    const rendered = render(
      <ConversationEvaluationCasePanel tenantId="tenant_1" venueId="venue_1" insights={[source]} />,
    )
    fireEvent.change(screen.getByLabelText('Sanitized visitor question'), {
      target: { value: 'Where is the entrance?' },
    })
    fireEvent.change(screen.getByLabelText('Acceptable answer phrases'), {
      target: { value: 'Use the north entrance' },
    })
    fireEvent.click(screen.getByLabelText('Confirm evaluation case redaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable case' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))

    const nextSource = { ...source, id: '33333333-3333-4333-8333-333333333333' }
    rendered.rerender(
      <ConversationEvaluationCasePanel
        tenantId="tenant_2"
        venueId="venue_2"
        insights={[nextSource]}
      />,
    )
    resolveMutation({ revision: 9, replayed: false })

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Confirm evaluation case redaction') as HTMLInputElement).disabled,
      ).toBe(false),
    )
    expect(screen.queryByText(/revision 9/)).toBeNull()
    expect(mocks.refresh).not.toHaveBeenCalled()

    mocks.mutate.mockResolvedValue({ revision: 10, replayed: false })
    fireEvent.change(screen.getByLabelText('Sanitized visitor question'), {
      target: { value: 'Where is the new entrance?' },
    })
    fireEvent.change(screen.getByLabelText('Acceptable answer phrases'), {
      target: { value: 'Ask the visitor desk' },
    })
    fireEvent.click(screen.getByLabelText('Confirm evaluation case redaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable case' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(2))
    expect(mocks.mutate.mock.calls[1]?.[0]).toMatchObject({
      tenantId: 'tenant_2',
      venueId: 'venue_2',
      insightId: nextSource.id,
    })
  })

  it('ignores a deferred result after unmount', async () => {
    let resolveMutation!: (value: { revision: number; replayed: boolean }) => void
    mocks.mutate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMutation = resolve
        }),
    )
    const rendered = render(
      <ConversationEvaluationCasePanel tenantId="tenant_1" venueId="venue_1" insights={[source]} />,
    )
    fireEvent.change(screen.getByLabelText('Sanitized visitor question'), {
      target: { value: 'Where is the entrance?' },
    })
    fireEvent.change(screen.getByLabelText('Acceptable answer phrases'), {
      target: { value: 'Use the north entrance' },
    })
    fireEvent.click(screen.getByLabelText('Confirm evaluation case redaction'))
    fireEvent.click(screen.getByRole('button', { name: 'Prepare immutable case' }))
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalledTimes(1))

    rendered.unmount()
    resolveMutation({ revision: 11, replayed: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
