export type ActionClassEvidencePage<T> = {
  items: readonly T[]
  nextCursor: unknown | null
}

export type ActionClassEvidenceAction = {
  id: string
  tenantId: string
  venueId: string | null
  agentIdentityId: string
  agentRunId: string
  actionName: string
  status: string
}

export type ActionClassEvidenceOutcome = {
  id: string
  tenantId: string
  venueId: string | null
  agentIdentityId: string
  agentRunId: string
  relatedAgentActionId: string | null
  signalKind: string
  verdict: string
}

export type ActionClassEvidenceApproval = {
  id: string
  tenantId: string
  venueId: string | null
  agentIdentityId: string
  proposedAction: string
  decision: 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED'
}

export type ActionClassEvidenceInput = {
  actions: ActionClassEvidencePage<ActionClassEvidenceAction>
  outcomes: ActionClassEvidencePage<ActionClassEvidenceOutcome>
  approvalDecisions: ActionClassEvidencePage<ActionClassEvidenceApproval>
}

export type ActionClassRecommendation =
  | 'COLLECT_MORE_EVIDENCE'
  | 'INSPECT_ADVERSE_EVIDENCE'
  | 'REVIEW_SCOPED_CANARY_EVIDENCE'

export type ActionClassEvidenceGroup = {
  key: string
  tenantId: string
  venueId: string | null
  agentIdentityId: string
  actionName: string
  actionIds: string[]
  successfulActionIds: string[]
  failedActionIds: string[]
  deniedActionIds: string[]
  cancelledActionIds: string[]
  successfulActionsWithoutQualityCount: number
  linkedOutcomeIds: string[]
  linkedPositiveOutcomeIds: string[]
  linkedAdverseOutcomeIds: string[]
  uncertainOutcomeIds: string[]
  approvalDecisionIds: string[]
  approvedApprovalDecisionIds: string[]
  rejectedApprovalDecisionIds: string[]
  uncertainApprovalDecisionIds: string[]
  recommendation: ActionClassRecommendation
  blocksPositiveRecommendation: boolean
  executionBoundaryBlocksPositive: boolean
  approvalBoundaryBlocksPositive: boolean
  uncertainEvidence: boolean
  incomplete: boolean
  evidence: {
    actionCount: number
    successfulActionCount: number
    failedActionCount: number
    deniedActionCount: number
    cancelledActionCount: number
    linkedOutcomeCount: number
    linkedPositiveOutcomeCount: number
    linkedAdverseOutcomeCount: number
    uncertainOutcomeCount: number
    approvalDecisionCount: number
    approvedApprovalDecisionCount: number
    rejectedApprovalDecisionCount: number
    uncertainApprovalDecisionCount: number
  }
}

export type ActionClassEvidenceProjection = {
  schemaVersion: 1
  recommendationOnly: true
  authorityChange: false
  emailReviewReductionRecommended: false
  groups: ActionClassEvidenceGroup[]
  incomplete: boolean
  unlinkedOutcomeIds: string[]
  mismatchedOutcomeIds: string[]
  conflictingOutcomeIds: string[]
  conflictingApprovalDecisionIds: string[]
  unmatchedApprovalDecisionIds: string[]
  sourceIds: {
    actionIds: string[]
    outcomeIds: string[]
    approvalDecisionIds: string[]
  }
}

type Scope = Pick<ActionClassEvidenceAction, 'tenantId' | 'venueId' | 'agentIdentityId'>

type RunScope = Scope & Pick<ActionClassEvidenceAction, 'agentRunId'>

function sameScope(left: RunScope, right: RunScope) {
  return (
    left.tenantId === right.tenantId &&
    left.venueId === right.venueId &&
    left.agentIdentityId === right.agentIdentityId &&
    left.agentRunId === right.agentRunId
  )
}

function groupKey(input: Pick<ActionClassEvidenceAction, keyof Scope | 'actionName'>) {
  return JSON.stringify([input.tenantId, input.venueId, input.agentIdentityId, input.actionName])
}

function uniqueIds(items: readonly { id: string }[]) {
  return [...new Set(items.map((item) => item.id))].sort()
}

function hasNext(page: { nextCursor: unknown | null }) {
  return page.nextCursor !== null
}

function isAdverse(outcome: ActionClassEvidenceOutcome) {
  return (
    outcome.signalKind === 'ROLLBACK' ||
    outcome.signalKind === 'POLICY_VIOLATION' ||
    outcome.verdict === 'NEGATIVE' ||
    outcome.verdict === 'MIXED'
  )
}

function isQualityOutcome(outcome: ActionClassEvidenceOutcome) {
  return outcome.signalKind === 'QUALITY_EVALUATION' || outcome.signalKind === 'HUMAN_REVIEW'
}

function isUncertainOutcome(outcome: ActionClassEvidenceOutcome) {
  return isQualityOutcome(outcome) && outcome.verdict === 'INCONCLUSIVE'
}

export function deriveActionClassEvidence(
  input: ActionClassEvidenceInput,
): ActionClassEvidenceProjection {
  const actions = [
    ...new Map(
      input.actions.items.map((item) => [
        JSON.stringify([
          item.id,
          item.tenantId,
          item.venueId,
          item.agentIdentityId,
          item.agentRunId,
          item.actionName,
          item.status,
        ]),
        item,
      ]),
    ).values(),
  ]
  const outcomeVariants = new Map<string, ActionClassEvidenceOutcome[]>()
  for (const item of input.outcomes.items) {
    outcomeVariants.set(item.id, [...(outcomeVariants.get(item.id) ?? []), item])
  }
  const conflictingOutcomeIds = [...outcomeVariants.entries()]
    .filter(([, variants]) => new Set(variants.map((item) => JSON.stringify(item))).size > 1)
    .map(([id]) => id)
  const outcomes = [...outcomeVariants.entries()]
    .filter(([id]) => !conflictingOutcomeIds.includes(id))
    .map(([, variants]) => variants[0]!)
  const approvalVariants = new Map<string, ActionClassEvidenceApproval[]>()
  for (const item of input.approvalDecisions.items) {
    approvalVariants.set(item.id, [...(approvalVariants.get(item.id) ?? []), item])
  }
  const conflictingApprovalDecisionIds = [...approvalVariants.entries()]
    .filter(([, variants]) => new Set(variants.map((item) => JSON.stringify(item))).size > 1)
    .map(([id]) => id)
  const approvals = [...approvalVariants.entries()]
    .filter(([id]) => !conflictingApprovalDecisionIds.includes(id))
    .map(([, variants]) => variants[0]!)
  const groups = new Map<string, ActionClassEvidenceGroup>()
  const actionsById = new Map<string, ActionClassEvidenceAction[]>()

  for (const action of actions) {
    const key = groupKey(action)
    const current = groups.get(key) ?? {
      key,
      tenantId: action.tenantId,
      venueId: action.venueId,
      agentIdentityId: action.agentIdentityId,
      actionName: action.actionName,
      actionIds: [],
      successfulActionIds: [],
      failedActionIds: [],
      deniedActionIds: [],
      cancelledActionIds: [],
      successfulActionsWithoutQualityCount: 0,
      linkedOutcomeIds: [],
      linkedPositiveOutcomeIds: [],
      linkedAdverseOutcomeIds: [],
      uncertainOutcomeIds: [],
      approvalDecisionIds: [],
      approvedApprovalDecisionIds: [],
      rejectedApprovalDecisionIds: [],
      uncertainApprovalDecisionIds: [],
      recommendation: 'COLLECT_MORE_EVIDENCE' as const,
      blocksPositiveRecommendation: false,
      executionBoundaryBlocksPositive: false,
      approvalBoundaryBlocksPositive: false,
      uncertainEvidence: false,
      incomplete: false,
      evidence: {
        actionCount: 0,
        successfulActionCount: 0,
        failedActionCount: 0,
        deniedActionCount: 0,
        cancelledActionCount: 0,
        linkedOutcomeCount: 0,
        linkedPositiveOutcomeCount: 0,
        linkedAdverseOutcomeCount: 0,
        uncertainOutcomeCount: 0,
        approvalDecisionCount: 0,
        approvedApprovalDecisionCount: 0,
        rejectedApprovalDecisionCount: 0,
        uncertainApprovalDecisionCount: 0,
      },
    }
    current.actionIds.push(action.id)
    if (action.status === 'SUCCEEDED') current.successfulActionIds.push(action.id)
    if (action.status === 'FAILED') current.failedActionIds.push(action.id)
    if (action.status === 'DENIED') current.deniedActionIds.push(action.id)
    if (action.status === 'CANCELLED') current.cancelledActionIds.push(action.id)
    current.evidence.actionCount += 1
    if (action.status === 'SUCCEEDED') current.evidence.successfulActionCount += 1
    if (action.status === 'FAILED') current.evidence.failedActionCount += 1
    if (action.status === 'DENIED') current.evidence.deniedActionCount += 1
    if (action.status === 'CANCELLED') current.evidence.cancelledActionCount += 1
    if (action.status !== 'SUCCEEDED') current.executionBoundaryBlocksPositive = true
    groups.set(key, current)
    actionsById.set(action.id, [...(actionsById.get(action.id) ?? []), action])
  }

  const unlinkedOutcomeIds: string[] = []
  const mismatchedOutcomeIds: string[] = []
  const qualityActionIdsByGroup = new Map<string, Set<string>>()
  for (const outcome of outcomes) {
    if (!outcome.relatedAgentActionId) {
      unlinkedOutcomeIds.push(outcome.id)
      continue
    }
    const candidates = actionsById.get(outcome.relatedAgentActionId) ?? []
    if (candidates.length !== 1 || !sameScope(candidates[0]!, outcome)) {
      mismatchedOutcomeIds.push(outcome.id)
      continue
    }
    const action = candidates[0]!
    const group = groups.get(groupKey(action))!
    group.linkedOutcomeIds.push(outcome.id)
    group.evidence.linkedOutcomeCount += 1
    if (outcome.verdict === 'POSITIVE' && isQualityOutcome(outcome)) {
      group.linkedPositiveOutcomeIds.push(outcome.id)
      group.evidence.linkedPositiveOutcomeCount += 1
    }
    if (isQualityOutcome(outcome)) {
      qualityActionIdsByGroup.set(
        group.key,
        new Set([...(qualityActionIdsByGroup.get(group.key) ?? []), action.id]),
      )
    }
    if (isAdverse(outcome)) {
      group.linkedAdverseOutcomeIds.push(outcome.id)
      group.blocksPositiveRecommendation = true
      group.evidence.linkedAdverseOutcomeCount += 1
    }
    if (isUncertainOutcome(outcome)) {
      group.uncertainOutcomeIds.push(outcome.id)
      group.uncertainEvidence = true
      group.blocksPositiveRecommendation = true
      group.evidence.uncertainOutcomeCount += 1
    }
  }

  const unmatchedApprovalDecisionIds: string[] = []
  for (const approval of approvals) {
    const key = JSON.stringify([
      approval.tenantId,
      approval.venueId,
      approval.agentIdentityId,
      approval.proposedAction,
    ])
    const matching = [...groups.values()].filter(
      (group) =>
        JSON.stringify([group.tenantId, group.venueId, group.agentIdentityId, group.actionName]) ===
        key,
    )
    if (matching.length === 0) {
      unmatchedApprovalDecisionIds.push(approval.id)
      continue
    }
    for (const group of matching) {
      group.approvalDecisionIds.push(approval.id)
      group.evidence.approvalDecisionCount += 1
      if (approval.decision === 'APPROVED') {
        group.approvedApprovalDecisionIds.push(approval.id)
        group.evidence.approvedApprovalDecisionCount += 1
      }
      if (approval.decision === 'REJECTED') {
        group.rejectedApprovalDecisionIds.push(approval.id)
        group.approvalBoundaryBlocksPositive = true
        group.blocksPositiveRecommendation = true
        group.evidence.rejectedApprovalDecisionCount += 1
      }
      if (approval.decision === 'CANCELLED' || approval.decision === 'EXPIRED') {
        group.uncertainApprovalDecisionIds.push(approval.id)
        group.uncertainEvidence = true
        group.blocksPositiveRecommendation = true
        group.evidence.uncertainApprovalDecisionCount += 1
      }
    }
  }

  const globallyIncomplete =
    hasNext(input.actions) || hasNext(input.outcomes) || hasNext(input.approvalDecisions)
  const unknownEvidence =
    unlinkedOutcomeIds.length > 0 ||
    mismatchedOutcomeIds.length > 0 ||
    conflictingOutcomeIds.length > 0 ||
    conflictingApprovalDecisionIds.length > 0
  for (const group of groups.values()) {
    const qualityActionIds = qualityActionIdsByGroup.get(group.key) ?? new Set<string>()
    group.successfulActionsWithoutQualityCount = group.successfulActionIds.filter(
      (id) => !qualityActionIds.has(id),
    ).length
    group.incomplete = globallyIncomplete || unknownEvidence
    group.blocksPositiveRecommendation =
      group.blocksPositiveRecommendation || group.executionBoundaryBlocksPositive
    group.recommendation =
      group.linkedAdverseOutcomeIds.length > 0
        ? 'INSPECT_ADVERSE_EVIDENCE'
        : group.blocksPositiveRecommendation ||
            globallyIncomplete ||
            unknownEvidence ||
            group.successfulActionsWithoutQualityCount > 0
          ? 'COLLECT_MORE_EVIDENCE'
          : group.evidence.successfulActionCount > 0 && group.linkedPositiveOutcomeIds.length > 0
            ? 'REVIEW_SCOPED_CANARY_EVIDENCE'
            : 'COLLECT_MORE_EVIDENCE'
  }

  return {
    schemaVersion: 1,
    recommendationOnly: true,
    authorityChange: false,
    emailReviewReductionRecommended: false,
    groups: [...groups.values()]
      .map((group) => ({
        ...group,
        actionIds: uniqueIds(group.actionIds.map((id) => ({ id }))),
        successfulActionIds: uniqueIds(group.successfulActionIds.map((id) => ({ id }))),
        failedActionIds: uniqueIds(group.failedActionIds.map((id) => ({ id }))),
        deniedActionIds: uniqueIds(group.deniedActionIds.map((id) => ({ id }))),
        cancelledActionIds: uniqueIds(group.cancelledActionIds.map((id) => ({ id }))),
        linkedOutcomeIds: uniqueIds(group.linkedOutcomeIds.map((id) => ({ id }))),
        linkedPositiveOutcomeIds: uniqueIds(group.linkedPositiveOutcomeIds.map((id) => ({ id }))),
        linkedAdverseOutcomeIds: uniqueIds(group.linkedAdverseOutcomeIds.map((id) => ({ id }))),
        uncertainOutcomeIds: uniqueIds(group.uncertainOutcomeIds.map((id) => ({ id }))),
        approvalDecisionIds: uniqueIds(group.approvalDecisionIds.map((id) => ({ id }))),
        approvedApprovalDecisionIds: uniqueIds(
          group.approvedApprovalDecisionIds.map((id) => ({ id })),
        ),
        rejectedApprovalDecisionIds: uniqueIds(
          group.rejectedApprovalDecisionIds.map((id) => ({ id })),
        ),
        uncertainApprovalDecisionIds: uniqueIds(
          group.uncertainApprovalDecisionIds.map((id) => ({ id })),
        ),
      }))
      .sort((left, right) => left.key.localeCompare(right.key)),
    incomplete: globallyIncomplete || unknownEvidence,
    unlinkedOutcomeIds: uniqueIds(unlinkedOutcomeIds.map((id) => ({ id }))),
    mismatchedOutcomeIds: uniqueIds(mismatchedOutcomeIds.map((id) => ({ id }))),
    conflictingOutcomeIds: uniqueIds(conflictingOutcomeIds.map((id) => ({ id }))),
    conflictingApprovalDecisionIds: uniqueIds(conflictingApprovalDecisionIds.map((id) => ({ id }))),
    unmatchedApprovalDecisionIds: uniqueIds(unmatchedApprovalDecisionIds.map((id) => ({ id }))),
    sourceIds: {
      actionIds: uniqueIds(input.actions.items),
      outcomeIds: uniqueIds(input.outcomes.items),
      approvalDecisionIds: uniqueIds(input.approvalDecisions.items),
    },
  }
}
