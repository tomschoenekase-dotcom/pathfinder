import { describe, expect, it } from 'vitest'

import { deriveAgentTrustEvidence } from './attention-agent-evidence'

const page = <T>(items: T[], hasMore = false) => ({
  items,
  nextCursor: hasMore ? { createdAt: '2026-08-22T00:00:00.000Z', id: 'next' } : null,
})
const identity = { id: 'agent_1', name: 'Support operator' }
const input = () => ({
  outcomes: page<never>([]),
  runs: page<never>([]),
  completedAgents: page<never>([]),
  actions: page<never>([]),
  approvalDecisions: page<never>([]),
})

describe('founder agent trust evidence', () => {
  it('does not treat completed execution as quality or permission evidence', () => {
    const result = deriveAgentTrustEvidence({
      ...input(),
      runs: page([
        { id: 'run_1', agentIdentityId: identity.id, status: 'COMPLETED', agentIdentity: identity },
      ]),
      completedAgents: page([
        {
          id: 'run_1',
          agentIdentityId: identity.id,
          status: 'COMPLETED',
          agentIdentity: identity,
          _count: { outcomeObservations: 0 },
        },
      ]),
    })

    expect(result).toMatchObject({
      schemaVersion: 2,
      state: 'NO_OUTCOME_EVIDENCE',
      observations: 0,
      runs: { visible: 1, completed: 1, failed: 0 },
      completedRuns: { visible: 1, withObservation: 0, withoutObservation: 1 },
      policy: { approvalReductionRecommended: false },
    })
    expect(result.policy.explanation).toContain('Completion alone is not quality evidence')
  })

  it('surfaces action, approval, quality, and customer evidence without inventing missing signals', () => {
    const result = deriveAgentTrustEvidence({
      ...input(),
      runs: page([
        { id: 'run_1', agentIdentityId: identity.id, status: 'COMPLETED', agentIdentity: identity },
        { id: 'run_2', agentIdentityId: identity.id, status: 'FAILED', agentIdentity: identity },
      ]),
      completedAgents: page([
        {
          id: 'run_1',
          agentIdentityId: identity.id,
          status: 'COMPLETED',
          agentIdentity: identity,
          _count: { outcomeObservations: 1 },
        },
      ]),
      outcomes: page([
        {
          agentRunId: 'run_1',
          agentIdentityId: identity.id,
          verdict: 'POSITIVE' as const,
          signalKind: 'HUMAN_REVIEW',
          taskClass: 'support',
          agentIdentity: identity,
        },
        {
          agentRunId: 'run_2',
          agentIdentityId: identity.id,
          verdict: 'NEGATIVE' as const,
          signalKind: 'QUALITY_EVALUATION',
          taskClass: 'support',
          agentIdentity: identity,
        },
        {
          agentRunId: 'run_2',
          agentIdentityId: identity.id,
          verdict: 'MIXED' as const,
          signalKind: 'CUSTOMER_SIGNAL',
          taskClass: 'support',
          agentIdentity: identity,
        },
      ]),
      actions: page([
        {
          agentIdentityId: identity.id,
          status: 'SUCCEEDED' as const,
          actionName: 'support.draft',
          agentIdentity: identity,
        },
        {
          agentIdentityId: identity.id,
          status: 'FAILED' as const,
          actionName: 'support.draft',
          agentIdentity: identity,
        },
        {
          agentIdentityId: identity.id,
          status: 'DENIED' as const,
          actionName: 'support.apply',
          agentIdentity: identity,
        },
      ]),
      approvalDecisions: page([
        {
          decision: 'APPROVED' as const,
          approvalRequest: {
            agentIdentityId: identity.id,
            proposedAction: 'support.apply',
            agentIdentity: identity,
          },
        },
        {
          decision: 'REJECTED' as const,
          approvalRequest: {
            agentIdentityId: identity.id,
            proposedAction: 'support.apply',
            agentIdentity: identity,
          },
        },
        {
          decision: 'EXPIRED' as const,
          approvalRequest: {
            agentIdentityId: identity.id,
            proposedAction: 'support.apply',
            agentIdentity: identity,
          },
        },
      ]),
    })

    expect(result).toMatchObject({
      state: 'NEGATIVE_EVIDENCE_PRESENT',
      actions: { visible: 3, succeeded: 1, failed: 1, denied: 1, cancelled: 0 },
      approvalDecisions: {
        visible: 3,
        approved: 1,
        rejected: 1,
        expired: 1,
        acceptance: { numerator: 1, denominator: 2, rate: 0.5 },
      },
      qualityEvaluations: { positive: 0, mixed: 0, negative: 1, inconclusive: 0 },
      customerSignals: { positive: 0, mixed: 1, negative: 0, inconclusive: 0 },
      evidenceCoverage: {
        deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION',
        rollbackRate: 'UNAVAILABLE_NO_CANONICAL_LINK',
        policyViolations: 'UNAVAILABLE_NO_CANONICAL_SIGNAL',
        confidenceCalibration: 'UNAVAILABLE_NO_PREDICTION_OUTCOME_PAIR',
      },
      byAgent: [
        {
          agentIdentityId: 'agent_1',
          runs: { visible: 2, completed: 1, failed: 1 },
          actions: { visible: 3, succeeded: 1, failed: 1, denied: 1 },
          approvals: { decided: 3, approved: 1, rejected: 1 },
          taskClasses: ['support'],
        },
      ],
      policy: { approvalReductionRecommended: false },
    })
  })

  it('labels positive-only evidence as bounded rather than proven autonomy', () => {
    const result = deriveAgentTrustEvidence({
      ...input(),
      outcomes: page(
        [
          {
            agentRunId: 'run_1',
            agentIdentityId: identity.id,
            verdict: 'POSITIVE' as const,
            signalKind: 'BUSINESS_OUTCOME',
            taskClass: 'onboarding',
            agentIdentity: identity,
          },
        ],
        true,
      ),
    })

    expect(result.state).toBe('POSITIVE_ONLY_EVIDENCE')
    expect(result.boundedSnapshot.hasMore).toBe(true)
    expect(result.policy.explanation).toContain('does not prove reliability')
  })
})
