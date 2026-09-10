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
vi.mock('./SemanticReviewedDeclineForm', () => ({
  SemanticReviewedDeclineForm: ({
    onFrozenChange,
    onRecorded,
  }: {
    onFrozenChange?: (frozen: boolean) => void
    onRecorded: () => void
  }) => (
    <>
      <button onClick={() => onFrozenChange?.(true)}>Fixture start reviewed decline</button>
      <button onClick={onRecorded}>Fixture finish reviewed decline</button>
    </>
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

  it('shows a durable duplicate receipt without reopening semantic draft actions', () => {
    render(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            status: 'APPROVED',
            observedVisitorClaim: null,
            aiInference: null,
            proposedChange: 'Visitor assistance is available at the welcome desk.',
            reason: 'Reviewed support guidance.',
            confidence: 0.98,
            evidenceMessageIds: ['message-1'],
            targetKnowledgeEntryId: 'entry-1',
            createdAt: '2026-09-10T11:00:00.000Z',
            updatedAt: '2026-09-10T12:01:00.000Z',
            reviewerId: 'reviewer-1',
            reviewNote: 'Approved evidence.',
            reviewedAt: '2026-09-10T12:00:00.000Z',
            duplicateResolution: {
              resolutionId: 'resolution-1',
              outcome: 'DUPLICATE_NOOP',
              targetKnowledgeEntryId: 'entry-1',
              relation: 'CORRECTS',
              createdAt: '2026-09-10T12:00:30.000Z',
              proposalRevisionCurrent: false,
              currentFulfillmentVerified: false,
            },
          },
        ]}
      />,
    )

    expect(screen.getByText('Duplicate review recorded')).toBeTruthy()
    expect(screen.getByText(/does not verify current fulfillment/)).toBeTruthy()
    expect(screen.getByText(/proposal has changed since this receipt/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Complete semantic resolution' })).toBeNull()
  })

  it('replaces bare support rejection with reviewed decline and freezes sibling approval', () => {
    const proposal = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'PENDING_REVIEW',
      observedVisitorClaim: null,
      aiInference: null,
      proposedChange: 'Retire unsupported guidance.',
      reason: 'Support review found insufficient evidence.',
      confidence: 0.8,
      evidenceMessageIds: ['message-1'],
      targetKnowledgeEntryId: 'entry-1',
      createdAt: '2026-09-10T11:00:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      reviewerId: null,
      reviewNote: null,
      reviewedAt: null,
      supportRequestId: 'request-1',
      canRecordReviewedDecline: true,
    }
    render(<KnowledgeProposalReview tenantId="tenant-1" venueId="venue-1" proposals={[proposal]} />)
    expect(screen.queryByRole('button', { name: 'Reject proposal' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Review note'), { target: { value: 'Approve.' } })
    const approve = screen.getByRole('button', { name: 'Approve evidence' }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Fixture start reviewed decline' }))
    expect(approve.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Complete semantic resolution' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Fixture finish reviewed decline' }))
    expect(screen.queryByRole('button', { name: 'Approve evidence' })).toBeNull()
    expect(screen.getByText('Reviewed decline recorded')).toBeTruthy()
  })

  it('renders current and stale reviewed-decline receipts without fulfillment claims', () => {
    const base = {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'REJECTED',
      observedVisitorClaim: null,
      aiInference: null,
      proposedChange: 'Retire unsupported guidance.',
      reason: 'Reviewed decline.',
      confidence: 0.8,
      evidenceMessageIds: ['message-1'],
      targetKnowledgeEntryId: 'entry-1',
      createdAt: '2026-09-10T11:00:00.000Z',
      updatedAt: '2026-09-10T12:00:00.000Z',
      reviewerId: 'reviewer-1',
      reviewNote: 'Declined.',
      reviewedAt: '2026-09-10T12:00:00.000Z',
      canRecordReviewedDecline: false,
    }
    const view = render(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[
          {
            ...base,
            reviewedDecline: {
              resolutionId: 'resolution-1',
              outcome: 'REVIEWED_DECLINE' as const,
              createdAt: '2026-09-10T12:01:00.000Z',
              proposalRevisionCurrent: true,
              currentFulfillmentVerified: false as const,
            },
          },
        ]}
      />,
    )
    expect(screen.getByText('Reviewed decline recorded')).toBeTruthy()
    expect(screen.getByText(/does not verify current fulfillment/)).toBeTruthy()
    expect(screen.queryByText(/proposal has changed/)).toBeNull()

    view.rerender(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[
          {
            ...base,
            reviewedDecline: {
              resolutionId: 'resolution-1',
              outcome: 'REVIEWED_DECLINE' as const,
              createdAt: '2026-09-10T12:01:00.000Z',
              proposalRevisionCurrent: false,
              currentFulfillmentVerified: false as const,
            },
          },
        ]}
      />,
    )
    expect(screen.getByText(/proposal has changed since this receipt/)).toBeTruthy()
  })

  it('keeps the legacy non-support reject action', () => {
    render(
      <KnowledgeProposalReview
        tenantId="tenant-1"
        venueId="venue-1"
        proposals={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            status: 'PENDING_REVIEW',
            observedVisitorClaim: null,
            aiInference: null,
            proposedChange: 'Legacy proposal.',
            reason: 'Legacy review.',
            confidence: 0.8,
            evidenceMessageIds: [],
            targetKnowledgeEntryId: null,
            createdAt: '2026-09-10T11:00:00.000Z',
            updatedAt: '2026-09-10T12:00:00.000Z',
            reviewerId: null,
            reviewNote: null,
            reviewedAt: null,
          },
        ]}
      />,
    )
    expect(screen.getByRole('button', { name: 'Reject proposal' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Fixture start reviewed decline' })).toBeNull()
  })
})
