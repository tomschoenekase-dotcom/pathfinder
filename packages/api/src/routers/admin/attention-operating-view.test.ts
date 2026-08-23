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
        schemaVersion: 1,
        state: 'NEGATIVE_EVIDENCE_PRESENT',
        verdicts: { positive: 1, mixed: 0, negative: 1, inconclusive: 0 },
        observations: 2,
        distinctObservedRuns: 2,
        completedRuns: { visible: 2, withObservation: 2, withoutObservation: 0 },
        taskClasses: ['support'],
        signalKinds: ['HUMAN_REVIEW'],
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
