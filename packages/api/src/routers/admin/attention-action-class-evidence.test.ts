import { describe, expect, it } from 'vitest'

import {
  deriveActionClassEvidence,
  type ActionClassEvidenceAction,
  type ActionClassEvidenceApproval,
  type ActionClassEvidenceOutcome,
} from './attention-action-class-evidence'

const page = <T>(items: readonly T[], hasMore = false) => ({
  items,
  nextCursor: hasMore ? { createdAt: '2026-09-08T00:00:00.000Z', id: 'next' } : null,
})

const action = (overrides: Partial<ActionClassEvidenceAction> = {}): ActionClassEvidenceAction => ({
  id: 'action-1',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  agentIdentityId: 'agent-a',
  agentRunId: 'run-a',
  actionName: 'support.draft',
  status: 'SUCCEEDED',
  ...overrides,
})

const outcome = (
  overrides: Partial<ActionClassEvidenceOutcome> = {},
): ActionClassEvidenceOutcome => ({
  id: 'outcome-1',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  agentIdentityId: 'agent-a',
  agentRunId: 'run-a',
  relatedAgentActionId: 'action-1',
  signalKind: 'QUALITY_EVALUATION',
  verdict: 'POSITIVE',
  ...overrides,
})

const approval = (
  overrides: Partial<ActionClassEvidenceApproval> = {},
): ActionClassEvidenceApproval => ({
  id: 'approval-1',
  tenantId: 'tenant-a',
  venueId: 'venue-a',
  agentIdentityId: 'agent-a',
  proposedAction: 'support.draft',
  decision: 'APPROVED',
  ...overrides,
})

const input = (
  overrides: {
    actions?: readonly ActionClassEvidenceAction[]
    outcomes?: readonly ActionClassEvidenceOutcome[]
    approvalDecisions?: readonly ActionClassEvidenceApproval[]
    actionsMore?: boolean
    outcomesMore?: boolean
    approvalsMore?: boolean
  } = {},
) => ({
  actions: page(overrides.actions ?? [], overrides.actionsMore),
  outcomes: page(overrides.outcomes ?? [], overrides.outcomesMore),
  approvalDecisions: page(overrides.approvalDecisions ?? [], overrides.approvalsMore),
})

describe('action-class evidence projection', () => {
  it('keeps tenant, venue, run, agent, and action class boundaries exact', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action(), action({ id: 'action-other-class', actionName: 'support.apply' })],
        outcomes: [
          outcome(),
          outcome({
            id: 'outcome-cross-scope',
            relatedAgentActionId: 'action-1',
            tenantId: 'tenant-b',
          }),
        ],
      }),
    )

    expect(result.groups).toHaveLength(2)
    expect(result.groups[0]?.linkedOutcomeIds).toEqual([])
    expect(result.mismatchedOutcomeIds).toEqual(['outcome-cross-scope'])
    expect(result.groups.some((group) => group.actionName === 'support.apply')).toBe(true)
    expect(result.groups.map((group) => group.actionName)).not.toContain('support')
  })

  it('does not transfer evidence between action classes or runs', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [
          action(),
          action({ id: 'action-2', agentRunId: 'run-b' }),
          action({ id: 'action-3', actionName: 'support.apply' }),
        ],
        outcomes: [outcome()],
      }),
    )

    const draft = result.groups.find((group) => group.actionName === 'support.draft')!
    expect(draft.successfulActionsWithoutQualityCount).toBe(1)
    expect(draft.recommendation).toBe('COLLECT_MORE_EVIDENCE')
    expect(
      result.groups.find((group) => group.actionName === 'support.apply')?.linkedOutcomeIds,
    ).toEqual([])
  })

  it('exposes unlinked and unknown outcome risk as incomplete', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action()],
        outcomes: [
          outcome({ id: 'outcome-unlinked', relatedAgentActionId: null }),
          outcome({ id: 'outcome-missing-action', relatedAgentActionId: 'missing-action' }),
        ],
      }),
    )

    expect(result.incomplete).toBe(true)
    expect(result.unlinkedOutcomeIds).toEqual(['outcome-unlinked'])
    expect(result.mismatchedOutcomeIds).toEqual(['outcome-missing-action'])
  })

  it('marks paginated samples incomplete and asks for more evidence', () => {
    const result = deriveActionClassEvidence(
      input({ actions: [action()], outcomes: [outcome()], actionsMore: true }),
    )

    expect(result.incomplete).toBe(true)
    expect(result.groups[0]).toMatchObject({
      incomplete: true,
      recommendation: 'COLLECT_MORE_EVIDENCE',
    })
  })

  it('does not treat a successful action without quality evidence as positive', () => {
    const result = deriveActionClassEvidence(input({ actions: [action()] }))

    expect(result.groups[0]).toMatchObject({
      successfulActionsWithoutQualityCount: 1,
      recommendation: 'COLLECT_MORE_EVIDENCE',
      blocksPositiveRecommendation: false,
    })
  })

  it('suggests scoped canary review only for linked positive evidence', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action()],
        outcomes: [outcome()],
        approvalDecisions: [approval()],
      }),
    )

    expect(result.groups[0]).toMatchObject({
      linkedPositiveOutcomeIds: ['outcome-1'],
      approvalDecisionIds: ['approval-1'],
      approvedApprovalDecisionIds: ['approval-1'],
      recommendation: 'REVIEW_SCOPED_CANARY_EVIDENCE',
    })
    expect(result).toMatchObject({
      authorityChange: false,
      emailReviewReductionRecommended: false,
      recommendationOnly: true,
    })
  })

  it('blocks positive recommendations for rollback, negative, or policy evidence', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action()],
        outcomes: [
          outcome({ id: 'rollback', signalKind: 'ROLLBACK', verdict: 'NEGATIVE' }),
          outcome({ id: 'policy', signalKind: 'POLICY_VIOLATION', verdict: 'POSITIVE' }),
        ],
      }),
    )

    expect(result.groups[0]).toMatchObject({
      linkedAdverseOutcomeIds: ['policy', 'rollback'],
      blocksPositiveRecommendation: true,
      recommendation: 'INSPECT_ADVERSE_EVIDENCE',
    })
  })

  it('blocks positive review for non-success actions without labeling denial as a policy incident', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [
          action({ id: 'failed', status: 'FAILED' }),
          action({ id: 'denied', status: 'DENIED' }),
          action({ id: 'cancelled', status: 'CANCELLED' }),
        ],
        outcomes: [
          outcome({ id: 'failed-quality', relatedAgentActionId: 'failed' }),
          outcome({ id: 'denied-quality', relatedAgentActionId: 'denied' }),
          outcome({ id: 'cancelled-quality', relatedAgentActionId: 'cancelled' }),
        ],
      }),
    )

    expect(result.groups[0]).toMatchObject({
      failedActionIds: ['failed'],
      deniedActionIds: ['denied'],
      cancelledActionIds: ['cancelled'],
      executionBoundaryBlocksPositive: true,
      linkedAdverseOutcomeIds: [],
      recommendation: 'COLLECT_MORE_EVIDENCE',
    })
  })

  it('treats rejected approval as a blocker and expired or cancelled approvals as uncertain', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action()],
        outcomes: [outcome()],
        approvalDecisions: [
          approval({ id: 'rejected', decision: 'REJECTED' }),
          approval({ id: 'expired', decision: 'EXPIRED' }),
          approval({ id: 'cancelled', decision: 'CANCELLED' }),
        ],
      }),
    )

    expect(result.groups[0]).toMatchObject({
      rejectedApprovalDecisionIds: ['rejected'],
      uncertainApprovalDecisionIds: ['cancelled', 'expired'],
      approvalBoundaryBlocksPositive: true,
      uncertainEvidence: true,
      recommendation: 'COLLECT_MORE_EVIDENCE',
    })
  })

  it('keeps inconclusive quality and conflicting duplicate IDs from becoming positive evidence', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action(), action({ id: 'action-2' })],
        outcomes: [
          outcome({
            id: 'inconclusive',
            relatedAgentActionId: 'action-1',
            verdict: 'INCONCLUSIVE',
          }),
          outcome({ id: 'positive', relatedAgentActionId: 'action-2' }),
          outcome({ id: 'conflict', relatedAgentActionId: 'action-1', verdict: 'POSITIVE' }),
          outcome({ id: 'conflict', relatedAgentActionId: 'action-2', verdict: 'NEGATIVE' }),
        ],
        approvalDecisions: [
          approval({ id: 'approval-conflict', decision: 'APPROVED' }),
          approval({ id: 'approval-conflict', decision: 'REJECTED' }),
        ],
      }),
    )

    expect(result.conflictingOutcomeIds).toEqual(['conflict'])
    expect(result.conflictingApprovalDecisionIds).toEqual(['approval-conflict'])
    expect(result.incomplete).toBe(true)
    expect(result.groups[0]).toMatchObject({
      uncertainOutcomeIds: ['inconclusive'],
      recommendation: 'COLLECT_MORE_EVIDENCE',
    })
  })

  it('deduplicates source IDs and leaves unrelated approvals explicit', () => {
    const result = deriveActionClassEvidence(
      input({
        actions: [action(), action()],
        outcomes: [outcome(), outcome()],
        approvalDecisions: [
          approval(),
          approval({ id: 'approval-other', proposedAction: 'support.apply' }),
        ],
      }),
    )

    expect(result.sourceIds).toEqual({
      actionIds: ['action-1'],
      outcomeIds: ['outcome-1'],
      approvalDecisionIds: ['approval-1', 'approval-other'],
    })
    expect(result.unmatchedApprovalDecisionIds).toEqual(['approval-other'])
  })
})
