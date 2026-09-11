/* @vitest-environment jsdom */

import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  updatePolicy: vi.fn(),
  reviewCandidate: vi.fn(),
  createProposal: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: {
      updateConversationLearningPolicy: { mutate: mocks.updatePolicy },
      reviewConversationLearningCandidate: { mutate: mocks.reviewCandidate },
      createKnowledgeProposal: { mutate: mocks.createProposal },
    },
  }),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: mocks.refresh }) }))

vi.mock('./ConversationLearningReview', () => ({
  ConversationLearningReview: ({
    policy,
    candidates,
    onPolicyChange,
    onReview,
  }: {
    policy: string
    candidates: Array<{ id: string; summary: string; candidateRevision: number }>
    onPolicyChange: (policy: string) => Promise<void>
    onReview: (command: {
      id: string
      expectedRevision: number
      decision: string
      summary: string
      feedback: string
    }) => Promise<void>
  }) => {
    const firstCandidate = candidates[0]
    const [summary, setSummary] = useState(firstCandidate?.summary ?? '')
    const [feedback, setFeedback] = useState('')
    const [error, setError] = useState('')
    return (
      <div>
        <span data-testid="forwarded-policy">{policy}</span>
        <span data-testid="forwarded-candidate">{candidates[0]?.id}</span>
        <textarea
          aria-label="Summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
        />
        <textarea
          aria-label="Feedback"
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
        />
        <button type="button" onClick={() => void onPolicyChange('EMPLOYEE_ONLY')}>
          Change policy
        </button>
        <button
          type="button"
          onClick={() => {
            if (!firstCandidate) return
            setError('')
            void onReview({
              id: firstCandidate.id,
              expectedRevision: firstCandidate.candidateRevision,
              decision: 'ACCEPT',
              summary,
              feedback,
            }).catch((caught: Error) => setError(caught.message))
          }}
        >
          Accept
        </button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    )
  },
}))

import { ConversationLearningWorkspace } from './ConversationLearningWorkspace'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const candidate = {
  id: 'candidate-7',
  summary: 'The east entrance is step-free.',
  reviewStatus: 'UNREVIEWED',
  candidateRevision: 4,
  reviewerFeedback: null,
  candidateProvenance: {
    source: 'PUBLIC' as const,
    kind: 'FACTUAL_ADDITION' as const,
    verification: 'UNVERIFIED' as const,
    hedged: false,
  },
}

function renderWorkspace() {
  return render(
    <ConversationLearningWorkspace
      tenantId="tenant/acme"
      venueId="venue west"
      policy="VISITOR_AND_EMPLOYEE"
      policyUpdatedAt="2026-09-08T17:30:00.000Z"
      candidates={[candidate]}
    />,
  )
}

describe('ConversationLearningWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updatePolicy.mockResolvedValue({})
    mocks.reviewCandidate.mockResolvedValue({})
  })

  afterEach(cleanup)

  it('forwards the current policy and candidate revision, scopes commands, and leaves actor identity to the server', async () => {
    renderWorkspace()

    expect(screen.getByTestId('forwarded-policy').textContent).toBe('VISITOR_AND_EMPLOYEE')
    expect(screen.getByTestId('forwarded-candidate').textContent).toBe('candidate-7')

    fireEvent.click(screen.getByRole('button', { name: 'Change policy' }))
    await waitFor(() => expect(mocks.updatePolicy).toHaveBeenCalledOnce())
    expect(mocks.updatePolicy).toHaveBeenCalledWith({
      tenantId: 'tenant/acme',
      venueId: 'venue west',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      policy: 'EMPLOYEE_ONLY',
      expectedUpdatedAt: new Date('2026-09-08T17:30:00.000Z'),
    })
    expect(mocks.updatePolicy.mock.calls[0]![0]).not.toHaveProperty('actor')
    expect(mocks.updatePolicy.mock.calls[0]![0]).not.toHaveProperty('authenticatedActorRef')

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Edited fact' } })
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Checked source' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    await waitFor(() => expect(mocks.reviewCandidate).toHaveBeenCalledOnce())
    expect(mocks.reviewCandidate).toHaveBeenCalledWith({
      tenantId: 'tenant/acme',
      venueId: 'venue west',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      insightId: 'candidate-7',
      expectedRevision: 4,
      action: 'ACCEPT_FOR_PROPOSAL',
      summary: 'Edited fact',
      reviewerFeedback: 'Checked source',
    })
    expect(mocks.reviewCandidate.mock.calls[0]![0]).not.toHaveProperty('actor')
    expect(mocks.reviewCandidate.mock.calls[0]![0]).not.toHaveProperty('authenticatedActorRef')
    expect(mocks.refresh).toHaveBeenCalledTimes(2)
  })

  it('creates only an evidence-linked draft and reuses its operation on an ambiguous retry', async () => {
    mocks.createProposal
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({ status: 'DRAFT' })
    render(
      <ConversationLearningWorkspace
        tenantId="tenant-1"
        venueId="venue-1"
        policy="VISITOR_AND_EMPLOYEE"
        policyUpdatedAt="2026-09-08T17:30:00.000Z"
        candidates={[
          {
            ...candidate,
            reviewStatus: 'ACKNOWLEDGED',
            evidenceMessageIds: ['exact-source-message'],
            reviewerFeedback: 'Compare with the venue label.',
          },
        ]}
      />,
    )
    fireEvent.change(screen.getByLabelText('Proposed canonical change'), {
      target: { value: 'The exhibit is in the north gallery.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create proposal draft' }))
    await screen.findByText(/Your entries are still here/)
    fireEvent.click(screen.getByRole('button', { name: 'Create proposal draft' }))
    await waitFor(() => expect(mocks.createProposal).toHaveBeenCalledTimes(2))
    const request = mocks.createProposal.mock.calls[0]![0]
    expect(mocks.createProposal.mock.calls[1]![0]).toEqual(request)
    expect(request).toEqual({
      tenantId: 'tenant-1',
      venueId: 'venue-1',
      operationId: expect.any(String),
      conversationInsightId: candidate.id,
      proposedChange: 'The exhibit is in the north gallery.',
      reason: 'Compare with the venue label.',
      confidence: 0,
      evidenceMessageIds: ['exact-source-message'],
      submitForReview: false,
    })
    expect(request).not.toHaveProperty('observedVisitorClaim')
    expect(request).not.toHaveProperty('authenticatedActorRef')
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
  })

  it('does not offer another draft for an active proposal or an unreviewed candidate', () => {
    const view = renderWorkspace()
    expect(screen.queryByText('Prepare proposal draft')).toBeNull()
    view.rerender(
      <ConversationLearningWorkspace
        tenantId="tenant-1"
        venueId="venue-1"
        policy="VISITOR_AND_EMPLOYEE"
        policyUpdatedAt="2026-09-08T17:30:00.000Z"
        candidates={[
          { ...candidate, reviewStatus: 'ACKNOWLEDGED', evidenceMessageIds: ['source'] },
        ]}
        activeProposalInsightIds={[candidate.id]}
      />,
    )
    expect(screen.queryByText('Prepare proposal draft')).toBeNull()
  })

  it('propagates review failures so visible unsaved edits remain available for retry', async () => {
    mocks.reviewCandidate.mockRejectedValue(new Error('conflict'))
    renderWorkspace()

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Keep this edit' } })
    fireEvent.change(screen.getByLabelText('Feedback'), { target: { value: 'Keep this evidence' } })
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/candidate changed/i)
    expect((screen.getByLabelText('Summary') as HTMLTextAreaElement).value).toBe('Keep this edit')
    expect((screen.getByLabelText('Feedback') as HTMLTextAreaElement).value).toBe(
      'Keep this evidence',
    )
    expect(mocks.refresh).not.toHaveBeenCalled()
  })
})
