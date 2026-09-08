/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

import { ConversationLearningReview } from './ConversationLearningReview'

afterEach(cleanup)

const candidate = {
  id: 'candidate-1',
  summary: 'A conversation message may contain a location or wayfinding fact.',
  sourceHref: '/admin/clients/tenant-1/venues/venue-1/chatlogs/session-1',
  reviewStatus: 'UNREVIEWED',
  candidateRevision: 3,
  reviewerFeedback: null,
  candidateProvenance: {
    source: 'PUBLIC' as const,
    kind: 'LOCATION' as const,
    verification: 'UNVERIFIED' as const,
    hedged: false,
  },
}

describe('ConversationLearningReview', () => {
  it('requires feedback and submits editable review data with the expected revision', async () => {
    const onReview = vi.fn().mockResolvedValue(undefined)
    render(
      <ConversationLearningReview
        policy="VISITOR_AND_EMPLOYEE"
        candidates={[candidate]}
        onPolicyChange={vi.fn()}
        onReview={onReview}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Accept for proposal' }))
    expect(screen.getByRole('alert').textContent).toContain('Add reviewer feedback')
    expect(
      screen.getByRole('link', { name: 'Review source conversation' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant-1/venues/venue-1/chatlogs/session-1')
    fireEvent.change(screen.getByLabelText('Proposed review summary'), {
      target: { value: 'Edited bounded location summary.' },
    })
    fireEvent.change(screen.getByLabelText(/Reviewer feedback/), {
      target: { value: 'Checked the source and retained the bounded wording.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Accept for proposal' }))
    await vi.waitFor(() =>
      expect(onReview).toHaveBeenCalledWith({
        id: 'candidate-1',
        expectedRevision: 3,
        decision: 'ACCEPT',
        summary: 'Edited bounded location summary.',
        feedback: 'Checked the source and retained the bounded wording.',
      }),
    )
  })

  it('renders source provenance, disabled policy, loading, error, and empty states', () => {
    const { rerender } = render(
      <ConversationLearningReview
        policy="EMPLOYEE_ONLY"
        candidates={[
          {
            ...candidate,
            candidateProvenance: { ...candidate.candidateProvenance, source: 'SECOND_LAYER' },
          },
        ]}
        onPolicyChange={vi.fn()}
        onReview={vi.fn()}
      />,
    )
    expect(screen.getByText('Unverified · Authenticated employee')).toBeTruthy()
    rerender(
      <ConversationLearningReview
        policy="DISABLED"
        candidates={[candidate]}
        onPolicyChange={vi.fn()}
        onReview={vi.fn()}
      />,
    )
    expect(screen.getByText('Candidate discovery is disabled.')).toBeTruthy()
    rerender(
      <ConversationLearningReview
        policy="VISITOR_AND_EMPLOYEE"
        candidates={[]}
        state="loading"
        onPolicyChange={vi.fn()}
        onReview={vi.fn()}
      />,
    )
    expect(screen.getByRole('status')).toBeTruthy()
    rerender(
      <ConversationLearningReview
        policy="VISITOR_AND_EMPLOYEE"
        candidates={[]}
        state="error"
        errorMessage="Fixture failed."
        onPolicyChange={vi.fn()}
        onReview={vi.fn()}
      />,
    )
    expect(screen.getByRole('alert').textContent).toContain('Fixture failed.')
    rerender(
      <ConversationLearningReview
        policy="VISITOR_AND_EMPLOYEE"
        candidates={[]}
        onPolicyChange={vi.fn()}
        onReview={vi.fn()}
      />,
    )
    expect(screen.getByText('No conversation candidates are waiting for review.')).toBeTruthy()
  })
})
