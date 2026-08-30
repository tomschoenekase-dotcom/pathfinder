export const FOUNDER_CHANGE_DIGEST_LIMIT = 5

type Source = {
  scope: 'PLATFORM' | 'TENANT'
  objectType: string
  objectId: string
  tenantId: string | null
  venueId: string | null
}

export type FounderBriefingChange = {
  kind: 'CRITICAL_RISK' | 'DECISION' | 'CUSTOMER' | 'OUTCOME' | 'COMPLETED_WORK'
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL'
  title: string
  detail: string
  occurredAt: Date
  action: { label: string; href: string }
  source: Source
}

export type FounderChangeDigestInput = {
  lastReviewedThrough: Date | null
  sourceHasMore: boolean
  events: Array<{
    id: string
    tenantId: string
    venueId: string | null
    eventType: string
    severity: string
    title: string
    summary: string
    recommendedAction: string | null
    lastOccurredAt: Date
  }>
  platformEvents: Array<{
    id: string
    eventType: string
    severity: string
    title: string
    summary: string
    recommendedAction: string | null
    lastOccurredAt: Date
  }>
  questions: Array<{
    id: string
    tenantId: string
    venueId: string
    question: string
    context: string | null
    agentIdentity: { name: string }
    createdAt: Date
  }>
  approvals: Array<{
    id: string
    tenantId: string
    venueId: string | null
    proposedAction: string
    riskCategory: string
    expired: boolean
    agentIdentity: { name: string }
    createdAt: Date
  }>
  completedAgents: Array<{
    id: string
    tenantId: string
    venueId: string | null
    requestedOperation: string
    completedAt: Date | null
    createdAt: Date
    agentIdentity: { name: string }
    _count: { outcomeObservations: number }
  }>
  outcomes: Array<{
    id: string
    tenantId: string
    venueId: string
    agentRunId: string
    verdict: string
    taskClass: string
    summary: string
    createdAt: Date
    agentIdentity: { name: string }
  }>
  support: Array<{
    id: string
    tenantId: string
    venueId: string
    subject: string
    category: string
    status: string
    updatedAt: Date
  }>
}

function tenantSource(
  objectType: string,
  objectId: string,
  tenantId: string,
  venueId: string | null,
): Source {
  return { scope: 'TENANT', objectType, objectId, tenantId, venueId }
}

function tenantEventHref(event: FounderChangeDigestInput['events'][number]) {
  if (!event.venueId) return `/admin/clients/${event.tenantId}`
  if (event.eventType.startsWith('evaluation.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/evaluations`
  if (event.eventType.startsWith('knowledge.proposal.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/knowledge-proposals`
  return `/admin/clients/${event.tenantId}/venues/${event.venueId}/chatlogs`
}

function platformEventHref(event: FounderChangeDigestInput['platformEvents'][number]) {
  if (event.eventType.startsWith('crm.import.')) return '/admin/prospects/imports'
  if (event.eventType.startsWith('crm.duplicate.')) return '/admin/prospects/duplicates'
  if (event.eventType.startsWith('crm.')) return '/admin/prospects'
  return '/admin/operations#alerts'
}

const priority: Record<FounderBriefingChange['kind'], number> = {
  CRITICAL_RISK: 0,
  DECISION: 1,
  CUSTOMER: 2,
  OUTCOME: 3,
  COMPLETED_WORK: 4,
}

export function deriveFounderChangeDigest(input: FounderChangeDigestInput) {
  const afterReview = (value: Date) =>
    input.lastReviewedThrough === null || value > input.lastReviewedThrough
  const changes: FounderBriefingChange[] = []

  for (const event of input.events) {
    if (!['CRITICAL', 'ERROR'].includes(event.severity) || !afterReview(event.lastOccurredAt))
      continue
    changes.push({
      kind: 'CRITICAL_RISK',
      urgency: 'CRITICAL',
      title: event.title,
      detail: event.recommendedAction || event.summary,
      occurredAt: event.lastOccurredAt,
      action: { label: 'Review risk', href: tenantEventHref(event) },
      source: tenantSource('operational-event', event.id, event.tenantId, event.venueId),
    })
  }

  for (const event of input.platformEvents) {
    if (!['CRITICAL', 'ERROR'].includes(event.severity) || !afterReview(event.lastOccurredAt))
      continue
    changes.push({
      kind: 'CRITICAL_RISK',
      urgency: 'CRITICAL',
      title: event.title,
      detail: event.recommendedAction || event.summary,
      occurredAt: event.lastOccurredAt,
      action: { label: 'Review platform risk', href: platformEventHref(event) },
      source: {
        scope: 'PLATFORM',
        objectType: 'platform-operational-event',
        objectId: event.id,
        tenantId: null,
        venueId: null,
      },
    })
  }

  for (const question of input.questions) {
    if (!afterReview(question.createdAt)) continue
    changes.push({
      kind: 'DECISION',
      urgency: 'HIGH',
      title: question.question,
      detail: question.context || `${question.agentIdentity.name} is waiting for input.`,
      occurredAt: question.createdAt,
      action: { label: 'Answer question', href: '/admin/operations#needs-you-heading' },
      source: tenantSource('agent-question', question.id, question.tenantId, question.venueId),
    })
  }

  for (const approval of input.approvals) {
    if (!afterReview(approval.createdAt)) continue
    changes.push({
      kind: 'DECISION',
      urgency: 'HIGH',
      title: approval.proposedAction,
      detail: approval.expired
        ? `${approval.agentIdentity.name} · decision window expired`
        : `${approval.agentIdentity.name} · ${approval.riskCategory.toLowerCase()} risk`,
      occurredAt: approval.createdAt,
      action: { label: 'Review approval', href: '/admin/operations#approval-attention-heading' },
      source: tenantSource('approval-request', approval.id, approval.tenantId, approval.venueId),
    })
  }

  for (const request of input.support) {
    if (!afterReview(request.updatedAt)) continue
    changes.push({
      kind: 'CUSTOMER',
      urgency: 'NORMAL',
      title: request.subject,
      detail: `${request.category.replaceAll('_', ' ').toLowerCase()} · ${request.status.replaceAll('_', ' ').toLowerCase()}`,
      occurredAt: request.updatedAt,
      action: {
        label: 'Review customer item',
        href: `/admin/clients/${request.tenantId}/venues/${request.venueId}/support-operations?requestId=${request.id}`,
      },
      source: tenantSource('support-request', request.id, request.tenantId, request.venueId),
    })
  }

  for (const outcome of input.outcomes) {
    if (!afterReview(outcome.createdAt)) continue
    changes.push({
      kind: 'OUTCOME',
      urgency: 'NORMAL',
      title: `${outcome.verdict.replaceAll('_', ' ').toLowerCase()} outcome · ${outcome.taskClass}`,
      detail: outcome.summary,
      occurredAt: outcome.createdAt,
      action: {
        label: 'Open outcome evidence',
        href: `/admin/clients/${outcome.tenantId}/venues/${outcome.venueId}/agents/runs/${outcome.agentRunId}`,
      },
      source: tenantSource(
        'agent-outcome-observation',
        outcome.id,
        outcome.tenantId,
        outcome.venueId,
      ),
    })
  }

  for (const run of input.completedAgents) {
    const occurredAt = run.completedAt ?? run.createdAt
    if (!afterReview(occurredAt)) continue
    changes.push({
      kind: 'COMPLETED_WORK',
      urgency: 'NORMAL',
      title: run.requestedOperation,
      detail: `${run.agentIdentity.name} completed this run · ${run._count.outcomeObservations} outcome signals`,
      occurredAt,
      action: {
        label: run.venueId ? 'Open run evidence' : 'Open client',
        href: run.venueId
          ? `/admin/clients/${run.tenantId}/venues/${run.venueId}/agents/runs/${run.id}`
          : `/admin/clients/${run.tenantId}`,
      },
      source: tenantSource('agent-run', run.id, run.tenantId, run.venueId),
    })
  }

  changes.sort(
    (left, right) =>
      priority[left.kind] - priority[right.kind] ||
      right.occurredAt.getTime() - left.occurredAt.getTime() ||
      left.source.objectId.localeCompare(right.source.objectId),
  )

  return {
    limit: FOUNDER_CHANGE_DIGEST_LIMIT,
    visibleCount: changes.length,
    mayHaveMore: changes.length > FOUNDER_CHANGE_DIGEST_LIMIT || input.sourceHasMore,
    items: changes.slice(0, FOUNDER_CHANGE_DIGEST_LIMIT),
  }
}
