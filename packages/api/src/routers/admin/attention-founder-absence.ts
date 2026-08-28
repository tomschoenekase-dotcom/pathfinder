type Page<T> = { items: T[]; nextCursor: unknown | null }

type FounderAbsenceInput = {
  generatedAt: Date
  jobs: Page<{ id: string }>
  evaluations: Page<{ id: string; status: string; expiredLease: boolean }>
  approvals: Page<{ id: string }>
  support: Page<{ id: string; status: string }>
  questions: Page<{ id: string; agentRunId: string | null; blocking: boolean }>
  blockedAgents: Page<{ id: string; status: string }>
  events: Page<{ id: string; occurrenceCount: number }>
  platformEvents: Page<{ id: string; occurrenceCount: number }>
  agentTrustEvidence: {
    actions: { denied: number }
    customerSignals: { negative: number }
    rollbackEvidence: { distinctActions: number }
    policyViolationEvidence: { observations: number }
    boundedSnapshot: { hasMore: boolean }
  }
}

const dimension = (
  key: string,
  label: string,
  visibleSignals: number,
  hasMore: boolean,
  interpretation: string,
) => ({
  key,
  label,
  visibleSignals,
  hasMore,
  state: visibleSignals > 0 ? ('REVIEW_CANDIDATES' as const) : ('NO_VISIBLE_SIGNAL' as const),
  interpretation,
})

export function deriveFounderAbsenceReadiness(input: FounderAbsenceInput) {
  const pages = [
    input.jobs,
    input.evaluations,
    input.approvals,
    input.support,
    input.questions,
    input.blockedAgents,
    input.events,
    input.platformEvents,
  ]
  const blockingQuestionRunIds = new Set(
    input.questions.items.flatMap((question) =>
      question.blocking && question.agentRunId ? [question.agentRunId] : [],
    ),
  )
  const repeatedEvents = [...input.events.items, ...input.platformEvents.items].filter(
    (event) => event.occurrenceCount > 1,
  )
  const founderWaits =
    input.questions.items.filter((question) => question.blocking).length +
    input.approvals.items.length +
    input.blockedAgents.items.filter(
      (run) => run.status === 'AWAITING_INPUT' || run.status === 'AWAITING_APPROVAL',
    ).length
  const permissionCandidates =
    input.blockedAgents.items.filter((run) => run.status === 'AWAITING_APPROVAL').length +
    input.agentTrustEvidence.actions.denied
  const companyResponseWork = input.support.items.filter(
    (request) => request.status !== 'WAITING_FOR_CLIENT',
  ).length
  const failedAutomation =
    input.jobs.items.length +
    input.evaluations.items.filter(
      (evaluation) =>
        evaluation.status === 'FAILED' ||
        evaluation.status === 'RETRY_SCHEDULED' ||
        evaluation.expiredLease,
    ).length +
    input.blockedAgents.items.filter((run) => run.status === 'FAILED').length
  const unlinkedInputWaits = input.blockedAgents.items.filter(
    (run) => run.status === 'AWAITING_INPUT' && !blockingQuestionRunIds.has(run.id),
  ).length
  const uncontrolledEffectEvidence =
    input.agentTrustEvidence.rollbackEvidence.distinctActions +
    input.agentTrustEvidence.policyViolationEvidence.observations +
    input.agentTrustEvidence.customerSignals.negative
  const pageHasMore = pages.some((page) => page.nextCursor !== null)
  const founderWaitsHaveMore =
    input.questions.nextCursor !== null ||
    input.approvals.nextCursor !== null ||
    input.blockedAgents.nextCursor !== null
  const dimensions = [
    dimension(
      'FOUNDER_WAITS',
      'Founder waits',
      founderWaits,
      founderWaitsHaveMore,
      'Blocking questions, undecided approvals, and waiting runs are review candidates; this view cannot decide which waits are unnecessary.',
    ),
    dimension(
      'PERMISSION_FRICTION',
      'Permission friction',
      permissionCandidates,
      input.blockedAgents.nextCursor !== null || input.agentTrustEvidence.boundedSnapshot.hasMore,
      'Approval-waiting runs and denied actions may show narrow permissions, but denial is not treated as a policy defect.',
    ),
    dimension(
      'REPEATED_ESCALATIONS',
      'Repeated escalations',
      repeatedEvents.length,
      input.events.nextCursor !== null || input.platformEvents.nextCursor !== null,
      'Counts open event groups with more than one recorded occurrence; no escalation-storm threshold has been invented.',
    ),
    dimension(
      'CUSTOMER_RESPONSE_WORK',
      'Customer response work',
      companyResponseWork,
      input.support.nextCursor !== null,
      'Active support work not waiting on the client is visible here; without a settled SLA, this is not labeled late or missed.',
    ),
    dimension(
      'FAILED_AUTOMATION',
      'Failed automation',
      failedAutomation,
      input.jobs.nextCursor !== null ||
        input.evaluations.nextCursor !== null ||
        input.blockedAgents.nextCursor !== null,
      'Visible failed jobs, failed or retrying evaluations, expired evaluation leases, and failed agent runs are counted as signals, not deduplicated incidents.',
    ),
    dimension(
      'HIDDEN_MANUAL_STEPS',
      'Hidden manual steps',
      unlinkedInputWaits,
      input.questions.nextCursor !== null || input.blockedAgents.nextCursor !== null,
      'An input-waiting run without a visible linked blocking question is a coordination gap candidate, not proof of hidden work.',
    ),
    dimension(
      'UNCONTROLLED_EFFECTS',
      'Uncontrolled effects',
      uncontrolledEffectEvidence,
      input.agentTrustEvidence.boundedSnapshot.hasMore,
      'Canonical rollback, policy-violation, and negative customer signals are counted; denied actions are intentionally excluded.',
    ),
  ]

  return {
    schemaVersion: 1 as const,
    generatedAt: input.generatedAt,
    kind: 'READINESS_SNAPSHOT' as const,
    target: {
      ordinaryOperationDays: 7 as const,
      launchGate: false as const,
      certification: 'NOT_STARTED' as const,
      observedDays: 0 as const,
      explanation:
        'A representative uninterrupted week has not been recorded. This current-state snapshot prepares the maturity test; it does not certify it.',
    },
    summary: {
      dimensionsWithReviewCandidates: dimensions.filter(
        (item) => item.state === 'REVIEW_CANDIDATES',
      ).length,
      visibleSignals: dimensions.reduce((sum, item) => sum + item.visibleSignals, 0),
    },
    dimensions,
    evidenceWindow: {
      kind: 'BOUNDED_CURRENT_STATE' as const,
      complete: !pageHasMore && !input.agentTrustEvidence.boundedSnapshot.hasMore,
      hasMore: pageHasMore || input.agentTrustEvidence.boundedSnapshot.hasMore,
      historicalContinuityVerified: false as const,
    },
    authority: {
      effect: 'READ_ONLY' as const,
      canChangePermissions: false as const,
      canResolveWork: false as const,
      canCertifyMaturity: false as const,
    },
  }
}
