/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it } from 'vitest'

import {
  ActionClassTrustEvidence,
  type ActionClassTrustEvidenceResult,
} from './ActionClassTrustEvidence'

afterEach(cleanup)

const result: ActionClassTrustEvidenceResult = {
  recommendationOnly: true,
  authorityChange: false,
  incomplete: true,
  unlinkedOutcomeIds: ['outcome-unlinked'],
  mismatchedOutcomeIds: ['outcome-mismatch'],
  conflictingOutcomeIds: ['outcome-conflict'],
  conflictingApprovalDecisionIds: ['approval-conflict'],
  unmatchedApprovalDecisionIds: ['approval-unmatched'],
  schemaVersion: 1,
  emailReviewReductionRecommended: false,
  sourceIds: {
    actionIds: ['action-1'],
    outcomeIds: ['outcome-positive', 'outcome-adverse'],
    approvalDecisionIds: ['approval-1'],
  },
  groups: [
    {
      key: 'draft-evidence',
      tenantId: 'tenant-museum',
      venueId: 'venue-north-gallery',
      agentIdentityId: 'agent-support-drafter',
      actionName: 'support.draft',
      actionIds: ['action-1'],
      successfulActionIds: ['action-1'],
      failedActionIds: ['action-failed'],
      deniedActionIds: ['action-denied'],
      cancelledActionIds: ['action-cancelled'],
      successfulActionsWithoutQualityCount: 3,
      linkedOutcomeIds: ['outcome-positive', 'outcome-adverse'],
      linkedPositiveOutcomeIds: ['outcome-positive'],
      linkedAdverseOutcomeIds: ['outcome-adverse'],
      uncertainOutcomeIds: ['outcome-uncertain'],
      approvalDecisionIds: ['approval-1'],
      approvedApprovalDecisionIds: ['approval-1'],
      rejectedApprovalDecisionIds: ['approval-rejected'],
      uncertainApprovalDecisionIds: ['approval-expired'],
      recommendation: 'INSPECT_ADVERSE_EVIDENCE',
      blocksPositiveRecommendation: true,
      executionBoundaryBlocksPositive: true,
      approvalBoundaryBlocksPositive: true,
      uncertainEvidence: true,
      incomplete: true,
      evidence: {
        actionCount: 6,
        successfulActionCount: 5,
        failedActionCount: 1,
        deniedActionCount: 1,
        cancelledActionCount: 1,
        linkedOutcomeCount: 3,
        linkedPositiveOutcomeCount: 2,
        linkedAdverseOutcomeCount: 1,
        uncertainOutcomeCount: 1,
        approvalDecisionCount: 2,
        approvedApprovalDecisionCount: 1,
        rejectedApprovalDecisionCount: 1,
        uncertainApprovalDecisionCount: 1,
      },
    },
  ],
}

describe('ActionClassTrustEvidence', () => {
  it('keeps identity, quality, execution-only, adverse, and incomplete evidence explicit', async () => {
    const { container } = render(<ActionClassTrustEvidence evidence={result} />)

    expect(screen.getByText('2 quality-linked positive · 3 execution-only success')).toBeTruthy()
    const disclosure = container.querySelector('summary')!
    fireEvent.click(disclosure)
    expect(screen.getByText('tenant-museum')).toBeTruthy()
    expect(screen.getByText('venue-north-gallery')).toBeTruthy()
    expect(screen.getByText('agent-support-drafter')).toBeTruthy()
    expect(screen.getByText('Inspect adverse evidence')).toBeTruthy()
    expect(screen.getByText(/sample is incomplete/i)).toBeTruthy()
    expect(screen.getByText('Unlinked outcomes: 1')).toBeTruthy()
    expect(screen.getByText('Scope mismatches: 1')).toBeTruthy()
    expect(screen.getByText('outcome-mismatch')).toBeTruthy()
    expect(screen.getByText('Conflicting outcomes: 1')).toBeTruthy()
    expect(screen.getByText('Conflicting approvals: 1')).toBeTruthy()
    expect(screen.getByText('Failed / denied')).toBeTruthy()
    expect(screen.getByText('Uncertain quality')).toBeTruthy()
    fireEvent.click(screen.getByText('Source record IDs'))
    expect(screen.getByText('action-1')).toBeTruthy()
    expect(screen.getByText(/no reliability score or authority change is inferred/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('renders nothing when the optional result is absent', () => {
    const { container } = render(<ActionClassTrustEvidence evidence={null} />)
    expect(container.innerHTML).toBe('')
  })
})
