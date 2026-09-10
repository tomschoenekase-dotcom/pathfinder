/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { reviewKnowledgeProposal: { mutate: vi.fn() } } }),
}))
vi.mock('./SemanticUpdatePreview', () => ({
  SemanticUpdatePreview: ({ onResolutionRecorded }: { onResolutionRecorded?: () => void }) => (
    <button type="button" onClick={onResolutionRecorded}>
      Complete semantic resolution
    </button>
  ),
}))

import { KnowledgeProposalReview } from './KnowledgeProposalReview'

afterEach(cleanup)

describe('KnowledgeProposalReview', () => {
  it('keeps an AI-prepared correction visibly review-only and links its exact source turn', () => {
    render(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            status: 'PENDING_REVIEW',
            sessionId: 'session-1',
            observedVisitorClaim: 'Visitor asked when the gallery closes.',
            aiInference: 'The answer lacked verified hours.',
            proposedChange: '[ADD]\nAdd the verified closing time.',
            reason: 'The low-confidence turn exposed a knowledge gap.',
            confidence: 0.82,
            evidenceMessageIds: ['message-user', 'message-assistant'],
            targetKnowledgeEntryId: null,
            createdAt: '2026-08-22T12:00:00.000Z',
            updatedAt: '2026-08-22T12:00:00.000Z',
            reviewerId: null,
            reviewNote: null,
            reviewedAt: null,
            createdByType: 'AGENT',
          },
        ]}
      />,
    )

    expect(screen.getByText('AI prepared')).toBeTruthy()
    expect(screen.getByText('2 exact message references retained')).toBeTruthy()
    expect(
      screen.getByRole('link', { name: 'Review source conversation' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant-1/venues/venue-1/chatlogs/session-1')
    expect(
      screen.getByText(
        'Approval records a human decision only. It does not publish or overwrite canonical knowledge.',
      ),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: /publish/i })).toBeNull()
  })

  it('renders an explicit empty state', () => {
    render(<KnowledgeProposalReview tenantId="tenant-1" venueId="venue-1" proposals={[]} />)
    expect(screen.getByText('No knowledge proposals are waiting for review.')).toBeTruthy()
  })

  it('marks only the exact proposal version closed after a recorded resolution', () => {
    const proposal = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'APPROVED',
      observedVisitorClaim: null,
      aiInference: null,
      proposedChange: 'Close at 7 PM.',
      reason: 'Reviewed conflict.',
      confidence: 0.8,
      evidenceMessageIds: ['message-1'],
      targetKnowledgeEntryId: 'entry-1',
      createdAt: '2026-09-10T11:00:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      reviewerId: 'reviewer-1',
      reviewNote: 'Approved evidence.',
      reviewedAt: '2026-09-10T12:00:00.000Z',
    }
    const view = render(
      <KnowledgeProposalReview tenantId="tenant-1" venueId="venue-1" proposals={[proposal]} />,
    )
    expect(screen.getByText('APPROVED')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Complete semantic resolution' }))
    expect(screen.getByText('CLOSED AFTER RESOLUTION')).toBeTruthy()

    view.rerender(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[{ ...proposal, updatedAt: '2026-09-10T12:01:00.000Z' }]}
      />,
    )
    expect(screen.getByText('APPROVED')).toBeTruthy()
    expect(screen.queryByText('CLOSED AFTER RESOLUTION')).toBeNull()
  })
})
