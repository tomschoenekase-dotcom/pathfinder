/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({ admin: { reviewKnowledgeProposal: { mutate: vi.fn() } } }),
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
})
