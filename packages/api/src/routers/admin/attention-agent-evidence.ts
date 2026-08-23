type Outcome = {
  agentRunId: string
  verdict: 'POSITIVE' | 'MIXED' | 'NEGATIVE' | 'INCONCLUSIVE'
  signalKind: string
  taskClass: string
}

type CompletedRun = {
  id: string
  _count: { outcomeObservations: number }
}

type Page<T> = { items: T[]; nextCursor: unknown | null }

export function deriveAgentTrustEvidence(input: {
  outcomes: Page<Outcome>
  completedAgents: Page<CompletedRun>
}) {
  const verdicts = {
    positive: input.outcomes.items.filter((item) => item.verdict === 'POSITIVE').length,
    mixed: input.outcomes.items.filter((item) => item.verdict === 'MIXED').length,
    negative: input.outcomes.items.filter((item) => item.verdict === 'NEGATIVE').length,
    inconclusive: input.outcomes.items.filter((item) => item.verdict === 'INCONCLUSIVE').length,
  }
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

  return {
    schemaVersion: 1 as const,
    state,
    verdicts,
    observations: input.outcomes.items.length,
    distinctObservedRuns: new Set(input.outcomes.items.map((item) => item.agentRunId)).size,
    completedRuns: {
      visible: input.completedAgents.items.length,
      withObservation: completedWithObservation,
      withoutObservation: completedWithoutObservation,
    },
    taskClasses: [...new Set(input.outcomes.items.map((item) => item.taskClass))].sort(),
    signalKinds: [...new Set(input.outcomes.items.map((item) => item.signalKind))].sort(),
    boundedSnapshot: {
      hasMore: input.outcomes.nextCursor !== null || input.completedAgents.nextCursor !== null,
    },
    policy: {
      approvalReductionRecommended: false as const,
      explanation: detail,
    },
  }
}
