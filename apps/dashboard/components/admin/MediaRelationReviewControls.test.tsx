/* @vitest-environment jsdom */

import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MediaRelationReviewControls,
  type MediaRelationReview,
} from './MediaRelationReviewControls'

const review = {
  id: '33333333-3333-4333-8333-333333333333',
  revision: 3,
  evidenceSnapshotHash: 'c'.repeat(64),
  createdAt: new Date('2026-09-07T12:00:00.000Z'),
  projection: {
    groups: [
      { representativeId: 'hall', candidateIds: ['hall'] },
      { representativeId: 'gallery', candidateIds: ['gallery'] },
    ],
    references: [
      { candidateId: 'hall', representativeId: 'hall' },
      { candidateId: 'gallery', representativeId: 'gallery' },
    ],
    activeMergeIds: [],
    relations: [],
    decisionCount: 0,
  },
  candidates: [
    {
      candidateId: 'hall',
      label: 'North Hall',
      kind: 'PLACE',
      evidenceLocatorIds: ['evidence:hall'],
      sourceIds: ['hall.jpg'],
    },
    {
      candidateId: 'gallery',
      label: 'Lake Gallery',
      kind: 'PLACE',
      evidenceLocatorIds: ['evidence:gallery'],
      sourceIds: ['gallery.jpg'],
    },
  ],
  decisions: [],
} satisfies MediaRelationReview

afterEach(cleanup)

function fillEndpoints() {
  fireEvent.change(screen.getByLabelText('From identity'), { target: { value: 'hall' } })
  fireEvent.change(screen.getByLabelText('To identity'), { target: { value: 'gallery' } })
}

describe('MediaRelationReviewControls', () => {
  it('requires explicit evidence for both endpoints and preserves unknown observation time', () => {
    const onDecision = vi.fn()
    render(<MediaRelationReviewControls review={review} disabled={false} onDecision={onDecision} />)
    fireEvent.click(screen.getByText('Propose a relation from retained evidence'))
    fillEndpoints()
    fireEvent.change(screen.getByLabelText('Relation kind'), { target: { value: 'CONTAINS' } })
    expect(screen.getByText(/from. is the container/i)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Evidence basis'), {
      target: { value: 'explicit_containment' },
    })
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'probable' } })
    fireEvent.change(screen.getByLabelText('Proposal rationale'), {
      target: { value: 'The retained plan explicitly places the gallery inside the hall.' },
    })
    const evidence = screen.getAllByRole('checkbox')
    fireEvent.click(evidence[0]!)
    expect(
      (screen.getByRole('button', { name: 'Record evidence proposal' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    fireEvent.click(evidence[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Record evidence proposal' }))
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PROPOSE_RELATION',
        relationKind: 'CONTAINS',
        basis: 'explicit_containment',
        evidenceLocatorIds: ['evidence:hall', 'evidence:gallery'],
        observationTime: { kind: 'UNKNOWN' },
      }),
    )
  })

  it('does not submit traversability until reviewed connection details are explicit', () => {
    const onDecision = vi.fn()
    render(<MediaRelationReviewControls review={review} disabled={false} onDecision={onDecision} />)
    fireEvent.click(screen.getByText('Propose a relation from retained evidence'))
    fillEndpoints()
    fireEvent.change(screen.getByLabelText('Relation kind'), { target: { value: 'TRAVERSABLE' } })
    fireEvent.change(screen.getByLabelText('Evidence basis'), { target: { value: 'doorway' } })
    fireEvent.change(screen.getByLabelText('Confidence'), { target: { value: 'unverified' } })
    screen.getAllByRole('checkbox').forEach((checkbox) => fireEvent.click(checkbox))
    fireEvent.change(screen.getByLabelText('Proposal rationale'), {
      target: { value: 'A doorway appears in both retained sources.' },
    })
    const submit = screen.getByRole('button', { name: 'Record evidence proposal' })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Connection kind'), { target: { value: 'DOOR' } })
    fireEvent.change(screen.getByLabelText('Direction'), { target: { value: 'yes' } })
    fireEvent.change(screen.getByLabelText('Accessibility'), { target: { value: 'UNKNOWN' } })
    fireEvent.change(screen.getByLabelText('Reviewed directions'), {
      target: { value: 'Use the north doorway.' },
    })
    fireEvent.click(submit)
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'PROPOSE_RELATION',
        traversal: expect.objectContaining({
          connectionKind: 'DOOR',
          bidirectional: true,
          accessibility: 'UNKNOWN',
        }),
      }),
    )
  })

  it('shows at most twenty relation histories per page', () => {
    const relations = Array.from({ length: 21 }, (_, index) => ({
      relationId: `relation-${index}`,
      proposalRequestId: `proposal-${index}`,
      originalFromCandidateId: 'hall',
      originalToCandidateId: 'gallery',
      fromCandidateId: 'hall',
      toCandidateId: 'gallery',
      relationKind: 'ADJACENT' as const,
      evidenceLocatorIds: ['evidence:hall', 'evidence:gallery'],
      basis: 'visual_overlap' as const,
      confidence: 'probable' as const,
      observationTime: { kind: 'UNKNOWN' as const },
      uncertainties: [],
      reviewStatus: 'PENDING' as const,
      reviewRequestId: null,
      endpointState: 'RESOLVED' as const,
      ambiguity: 'NONE' as const,
    }))
    render(
      <MediaRelationReviewControls
        review={{ ...review, projection: { ...review.projection, relations } }}
        disabled={false}
        onDecision={vi.fn()}
      />,
    )
    expect(screen.getAllByRole('button', { name: 'Review as accepted' })).toHaveLength(20)
    fireEvent.click(screen.getByRole('button', { name: 'Next relations' }))
    expect(screen.getAllByRole('button', { name: 'Review as accepted' })).toHaveLength(1)
    expect(screen.getByText('Page 2 of 2')).toBeTruthy()
  })

  it('records explicit review and revert rationale and has no automated accessibility violations', async () => {
    const onDecision = vi.fn()
    const relation = {
      relationId: 'relation-a',
      proposalRequestId: '11111111-1111-4111-8111-111111111111',
      originalFromCandidateId: 'hall',
      originalToCandidateId: 'gallery',
      fromCandidateId: 'hall',
      toCandidateId: 'gallery',
      relationKind: 'ADJACENT' as const,
      evidenceLocatorIds: ['evidence:hall', 'evidence:gallery'],
      basis: 'visual_overlap' as const,
      confidence: 'probable' as const,
      observationTime: { kind: 'UNKNOWN' as const },
      uncertainties: [],
      reviewStatus: 'PENDING' as const,
      reviewRequestId: null,
      endpointState: 'RESOLVED' as const,
      ambiguity: 'NONE' as const,
    }
    const { container, rerender } = render(
      <MediaRelationReviewControls
        review={{ ...review, projection: { ...review.projection, relations: [relation] } }}
        disabled={false}
        onDecision={onDecision}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Review as accepted' }))
    fireEvent.change(screen.getByLabelText('Why this proposal is accepted'), {
      target: { value: 'Both endpoints and evidence locators are verified.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm relation review' }))
    expect(onDecision).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'REVIEW_RELATION', verdict: 'ACCEPTED' }),
    )

    rerender(
      <MediaRelationReviewControls
        review={{
          ...review,
          projection: {
            ...review.projection,
            relations: [
              {
                ...relation,
                reviewStatus: 'ACCEPTED',
                reviewRequestId: '22222222-2222-4222-8222-222222222222',
              },
            ],
          },
        }}
        disabled={false}
        onDecision={onDecision}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Revert this relation review' }))
    fireEvent.change(screen.getByLabelText('Why this relation review should be reverted'), {
      target: { value: 'The retained evidence needs another review.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm review reversion' }))
    expect(onDecision).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'REVERT_RELATION' }),
    )
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })
})
