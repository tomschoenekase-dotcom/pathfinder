import { describe, expect, it } from 'vitest'

import { deriveFounderOperatingView } from './attention-operating-view'

describe('founder operating view', () => {
  it('projects compact evidence without granting execution authority', () => {
    const generatedAt = new Date('2026-08-22T20:00:00.000Z')
    const result = deriveFounderOperatingView({
      generatedAt,
      briefing: {
        schemaVersion: 1,
        focus: {
          kind: 'APPROVAL',
          urgency: 'HIGH',
          label: 'Founder decision',
          title: 'Approve customer lifecycle change',
          detail: 'One bounded approval request is waiting.',
          action: {
            label: 'Make a decision',
            href: '/admin/operations#approval-attention-heading',
          },
          source: {
            scope: 'TENANT',
            objectType: 'approval-request',
            objectId: 'approval_1',
            tenantId: 'tenant_1',
            venueId: 'venue_1',
          },
        },
        metrics: { decisions: 1, criticalRisks: 0, workingAgents: 2, customerItems: 0 },
        boundedSnapshot: { limit: 10, hasMore: false },
        reviewState: {
          lastReviewedThrough: null,
          changesSinceLastReview: {
            criticalRisks: 0,
            decisions: 1,
            completedAgents: 0,
            outcomes: 1,
            customerItems: 0,
          },
          changeDigest: { limit: 5, visibleCount: 0, mayHaveMore: false, items: [] },
          hasUnreviewedChanges: true,
        },
      },
      agentTrustEvidence: {
        schemaVersion: 2,
        state: 'NEGATIVE_EVIDENCE_PRESENT',
        verdicts: { positive: 1, mixed: 0, negative: 1, inconclusive: 0 },
        observations: 2,
        distinctObservedRuns: 2,
        completedRuns: { visible: 2, withObservation: 2, withoutObservation: 0 },
        runs: { visible: 2, completed: 2, failed: 0 },
        actions: { visible: 2, succeeded: 2, failed: 0, denied: 0, cancelled: 0 },
        approvalDecisions: {
          visible: 1,
          approved: 1,
          rejected: 0,
          cancelled: 0,
          expired: 0,
          acceptance: { numerator: 1, denominator: 1, rate: 1, excludes: ['CANCELLED', 'EXPIRED'] },
        },
        qualityEvaluations: { positive: 0, mixed: 0, negative: 1, inconclusive: 0 },
        customerSignals: { positive: 0, mixed: 0, negative: 0, inconclusive: 0 },
        taskClasses: ['support'],
        signalKinds: ['HUMAN_REVIEW'],
        byAgent: [],
        evidenceCoverage: {
          executionRuns: 'AVAILABLE',
          explicitOutcomes: 'AVAILABLE',
          toolActions: 'AVAILABLE',
          approvalAcceptance: 'AVAILABLE',
          deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION',
          rollbackRate: 'UNAVAILABLE_NO_CANONICAL_LINK',
          policyViolations: 'UNAVAILABLE_NO_CANONICAL_SIGNAL',
          confidenceCalibration: 'UNAVAILABLE_NO_PREDICTION_OUTCOME_PAIR',
        },
        boundedSnapshot: { hasMore: false },
        policy: {
          approvalReductionRecommended: false,
          explanation: 'Negative evidence is present.',
        },
      },
    })

    expect(result).toMatchObject({
      schemaVersion: 1,
      generatedAt,
      scope: 'PLATFORM',
      effect: 'READ_ONLY',
      focus: { kind: 'APPROVAL', source: { objectId: 'approval_1' } },
      autonomyEvidence: {
        state: 'NEGATIVE_EVIDENCE_PRESENT',
        policy: { approvalReductionRecommended: false },
      },
      authority: {
        transport: 'PLATFORM_ADMIN_SESSION_ONLY',
        customerCredentialCompatible: false,
        canExecute: false,
        canApprove: false,
        canAcknowledge: false,
        canMutatePolicy: false,
      },
    })
  })
})
