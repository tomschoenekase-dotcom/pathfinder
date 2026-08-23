type Verdict = 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'INCONCLUSIVE'

type Identity = { id: string; name: string }
type Outcome = {
  agentRunId: string
  agentIdentityId: string
  verdict: Verdict
  signalKind: string
  taskClass: string
  agentIdentity: Identity
}
type Run = {
  id: string
  agentIdentityId: string
  status: string
  agentIdentity: Identity
}
type CompletedRun = Run & { _count: { outcomeObservations: number } }
type Action = {
  agentIdentityId: string
  status: 'SUCCEEDED' | 'FAILED' | 'DENIED' | 'CANCELLED'
  actionName: string
  agentIdentity: Identity
}
type Approval = {
  decision: 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
  approvalRequest: {
    agentIdentityId: string
    proposedAction: string
    agentIdentity: Identity
  }
}
type Page<T> = { items: T[]; nextCursor: unknown | null }

const verdictCounts = (items: readonly { verdict: Verdict }[]) => ({
  positive: items.filter((item) => item.verdict === 'POSITIVE').length,
  mixed: items.filter((item) => item.verdict === 'MIXED').length,
  negative: items.filter((item) => item.verdict === 'NEGATIVE').length,
  inconclusive: items.filter((item) => item.verdict === 'INCONCLUSIVE').length,
})

export function deriveAgentTrustEvidence(input: {
  outcomes: Page<Outcome>
  runs: Page<Run>
  completedAgents: Page<CompletedRun>
  actions: Page<Action>
  approvalDecisions: Page<Approval>
}) {
  const verdicts = verdictCounts(input.outcomes.items)
  const completedWithObservation = input.completedAgents.items.filter(
    (item) => item._count.outcomeObservations > 0,
  ).length
  const completedWithoutObservation = input.completedAgents.items.length - completedWithObservation
  const state =
    input.outcomes.items.length === 0
      ? 'NO_OUTCOME_EVIDENCE'
      : verdicts.negative > 0
        ? 'NEGATIVE_EVIDENCE_PRESENT'
        : verdicts.mixed > 0 || verdicts.inconclusive > 0
          ? 'MIXED_OR_INCONCLUSIVE_EVIDENCE'
          : 'POSITIVE_ONLY_EVIDENCE'
  const detail =
    state === 'NO_OUTCOME_EVIDENCE'
      ? 'Completion alone is not quality evidence. Record explicit outcomes before considering any change to approval policy.'
      : state === 'NEGATIVE_EVIDENCE_PRESENT'
        ? 'Negative evidence is present. Inspect the underlying runs and corrections; this snapshot does not support reducing approval.'
        : state === 'MIXED_OR_INCONCLUSIVE_EVIDENCE'
          ? 'Observed evidence is mixed or inconclusive. Keep current policy while reviewing task-specific evidence.'
          : 'Recent observed evidence is positive, but a bounded positive-only sample does not prove reliability or justify reducing approval.'

  const actionStatuses = {
    succeeded: input.actions.items.filter((item) => item.status === 'SUCCEEDED').length,
    failed: input.actions.items.filter((item) => item.status === 'FAILED').length,
    denied: input.actions.items.filter((item) => item.status === 'DENIED').length,
    cancelled: input.actions.items.filter((item) => item.status === 'CANCELLED').length,
  }
  const approvalDecisions = {
    approved: input.approvalDecisions.items.filter((item) => item.decision === 'APPROVED').length,
    rejected: input.approvalDecisions.items.filter((item) => item.decision === 'REJECTED').length,
    cancelled: input.approvalDecisions.items.filter((item) => item.decision === 'CANCELLED').length,
    expired: input.approvalDecisions.items.filter((item) => item.decision === 'EXPIRED').length,
  }
  const approvalAcceptanceDenominator = approvalDecisions.approved + approvalDecisions.rejected
  const identities = new Map<string, Identity>()
  for (const item of [
    ...input.runs.items,
    ...input.completedAgents.items,
    ...input.outcomes.items,
    ...input.actions.items,
  ]) {
    identities.set(item.agentIdentityId, item.agentIdentity)
  }
  for (const item of input.approvalDecisions.items) {
    identities.set(item.approvalRequest.agentIdentityId, item.approvalRequest.agentIdentity)
  }

  const byAgent = [...identities.values()]
    .map((identity) => {
      const runs = input.runs.items.filter((item) => item.agentIdentityId === identity.id)
      const actions = input.actions.items.filter((item) => item.agentIdentityId === identity.id)
      const outcomes = input.outcomes.items.filter((item) => item.agentIdentityId === identity.id)
      const approvals = input.approvalDecisions.items.filter(
        (item) => item.approvalRequest.agentIdentityId === identity.id,
      )
      return {
        agentIdentityId: identity.id,
        name: identity.name,
        runs: {
          visible: runs.length,
          completed: runs.filter((item) => item.status === 'COMPLETED').length,
          failed: runs.filter((item) => item.status === 'FAILED').length,
        },
        actions: {
          visible: actions.length,
          succeeded: actions.filter((item) => item.status === 'SUCCEEDED').length,
          failed: actions.filter((item) => item.status === 'FAILED').length,
          denied: actions.filter((item) => item.status === 'DENIED').length,
        },
        outcomes: verdictCounts(outcomes),
        approvals: {
          decided: approvals.length,
          approved: approvals.filter((item) => item.decision === 'APPROVED').length,
          rejected: approvals.filter((item) => item.decision === 'REJECTED').length,
        },
        taskClasses: [...new Set(outcomes.map((item) => item.taskClass))].sort(),
      }
    })
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.agentIdentityId.localeCompare(right.agentIdentityId),
    )

  return {
    schemaVersion: 2 as const,
    state,
    verdicts,
    observations: input.outcomes.items.length,
    distinctObservedRuns: new Set(input.outcomes.items.map((item) => item.agentRunId)).size,
    runs: {
      visible: input.runs.items.length,
      completed: input.runs.items.filter((item) => item.status === 'COMPLETED').length,
      failed: input.runs.items.filter((item) => item.status === 'FAILED').length,
    },
    completedRuns: {
      visible: input.completedAgents.items.length,
      withObservation: completedWithObservation,
      withoutObservation: completedWithoutObservation,
    },
    actions: { visible: input.actions.items.length, ...actionStatuses },
    approvalDecisions: {
      visible: input.approvalDecisions.items.length,
      ...approvalDecisions,
      acceptance: {
        numerator: approvalDecisions.approved,
        denominator: approvalAcceptanceDenominator,
        rate: approvalAcceptanceDenominator
          ? approvalDecisions.approved / approvalAcceptanceDenominator
          : null,
        excludes: ['CANCELLED', 'EXPIRED'] as const,
      },
    },
    qualityEvaluations: verdictCounts(
      input.outcomes.items.filter((item) => item.signalKind === 'QUALITY_EVALUATION'),
    ),
    customerSignals: verdictCounts(
      input.outcomes.items.filter((item) => item.signalKind === 'CUSTOMER_SIGNAL'),
    ),
    taskClasses: [...new Set(input.outcomes.items.map((item) => item.taskClass))].sort(),
    signalKinds: [...new Set(input.outcomes.items.map((item) => item.signalKind))].sort(),
    byAgent,
    evidenceCoverage: {
      executionRuns: 'AVAILABLE' as const,
      explicitOutcomes: 'AVAILABLE' as const,
      toolActions: 'AVAILABLE' as const,
      approvalAcceptance: 'AVAILABLE' as const,
      deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION' as const,
      rollbackRate: 'UNAVAILABLE_NO_CANONICAL_LINK' as const,
      policyViolations: 'UNAVAILABLE_NO_CANONICAL_SIGNAL' as const,
      confidenceCalibration: 'UNAVAILABLE_NO_PREDICTION_OUTCOME_PAIR' as const,
    },
    boundedSnapshot: {
      hasMore: [
        input.outcomes,
        input.runs,
        input.completedAgents,
        input.actions,
        input.approvalDecisions,
      ].some((value) => value.nextCursor !== null),
    },
    policy: { approvalReductionRecommended: false as const, explanation: detail },
  }
}
