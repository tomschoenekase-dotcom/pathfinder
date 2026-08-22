import { deriveFounderChangeDigest } from './attention-change-digest'

type TenantEvent = {
  id: string
  tenantId: string
  venueId: string | null
  eventType: string
  severity: string
  title: string
  summary: string
  recommendedAction: string | null
  actionRequired: boolean
  lastOccurredAt: Date
}

type PlatformEvent = {
  id: string
  eventType: string
  severity: string
  title: string
  summary: string
  recommendedAction: string | null
  actionRequired: boolean
  lastOccurredAt: Date
}

type Question = {
  id: string
  tenantId: string
  venueId: string
  question: string
  context: string | null
  blocking: boolean
  agentIdentity: { name: string }
  createdAt: Date
}

type Approval = {
  id: string
  tenantId: string
  venueId: string | null
  proposedAction: string
  riskCategory: string
  expired: boolean
  agentIdentity: { name: string }
  createdAt: Date
}

type AgentRun = {
  id: string
  tenantId: string
  venueId: string | null
  requestedOperation: string
  status: string
  agentIdentity: { name: string }
}

type SupportRequest = {
  id: string
  tenantId: string
  venueId: string
  subject: string
  category: string
  status: string
  updatedAt: Date
}

type CompletedAgentRun = {
  id: string
  tenantId: string
  venueId: string | null
  requestedOperation: string
  completedAt: Date | null
  createdAt: Date
  agentIdentity: { name: string }
  _count: { outcomeObservations: number }
}
type Outcome = {
  id: string
  tenantId: string
  venueId: string
  agentRunId: string
  verdict: string
  taskClass: string
  summary: string
  createdAt: Date
  agentIdentity: { name: string }
}

type Page<T> = { items: T[]; nextCursor: unknown | null }

export type FounderBriefingFocus = {
  kind:
    | 'CUSTOMER_RISK'
    | 'PLATFORM_RISK'
    | 'FOUNDER_QUESTION'
    | 'APPROVAL'
    | 'BLOCKED_WORK'
    | 'CUSTOMER_SUPPORT'
    | 'CLEAR'
  urgency: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'NONE'
  label: string
  title: string
  detail: string
  action: { label: string; href: string }
  source: {
    scope: 'PLATFORM' | 'TENANT'
    objectType: string
    objectId: string | null
    tenantId: string | null
    venueId: string | null
  }
}

export type FounderBriefingInput = {
  limit: number
  lastReviewedThrough: Date | null
  events: Page<TenantEvent>
  platformEvents: Page<PlatformEvent>
  questions: Page<Question>
  approvals: Page<Approval>
  blockedAgents: Page<AgentRun>
  support: Page<SupportRequest>
  workingAgents: Page<unknown>
  completedAgents: Page<CompletedAgentRun>
  outcomes: Page<Outcome>
}

function tenantEventHref(event: TenantEvent) {
  if (!event.venueId) return `/admin/clients/${event.tenantId}`
  if (event.eventType.startsWith('evaluation.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/evaluations`
  if (event.eventType.startsWith('knowledge.proposal.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/knowledge-proposals`
  return `/admin/clients/${event.tenantId}/venues/${event.venueId}/chatlogs`
}

function platformEventHref(event: PlatformEvent) {
  if (event.eventType.startsWith('crm.import.')) return '/admin/prospects/imports'
  if (event.eventType.startsWith('crm.duplicate.')) return '/admin/prospects/duplicates'
  if (event.eventType.startsWith('crm.')) return '/admin/prospects'
  return '/admin/operations#alerts'
}

function tenantSource(
  objectType: string,
  objectId: string,
  tenantId: string,
  venueId: string | null,
) {
  return { scope: 'TENANT' as const, objectType, objectId, tenantId, venueId }
}

export function deriveFounderBriefing(input: FounderBriefingInput) {
  const urgentTenantEvent = input.events.items.find(
    (event) => event.actionRequired && ['CRITICAL', 'ERROR'].includes(event.severity),
  )
  const urgentPlatformEvent = input.platformEvents.items.find(
    (event) => event.actionRequired && ['CRITICAL', 'ERROR'].includes(event.severity),
  )
  const blockingQuestion = input.questions.items.find((question) => question.blocking)
  const approval = input.approvals.items.find((item) => !item.expired)
  const blockedRun = input.blockedAgents.items[0]
  const support = input.support.items[0]

  let focus: FounderBriefingFocus
  if (urgentTenantEvent) {
    focus = {
      kind: 'CUSTOMER_RISK',
      urgency: 'CRITICAL',
      label: 'Customer or system risk',
      title: urgentTenantEvent.title,
      detail: urgentTenantEvent.recommendedAction || urgentTenantEvent.summary,
      action: { label: 'Review risk now', href: tenantEventHref(urgentTenantEvent) },
      source: tenantSource(
        'operational-event',
        urgentTenantEvent.id,
        urgentTenantEvent.tenantId,
        urgentTenantEvent.venueId,
      ),
    }
  } else if (urgentPlatformEvent) {
    focus = {
      kind: 'PLATFORM_RISK',
      urgency: 'CRITICAL',
      label: 'Platform risk',
      title: urgentPlatformEvent.title,
      detail: urgentPlatformEvent.recommendedAction || urgentPlatformEvent.summary,
      action: { label: 'Review platform risk', href: platformEventHref(urgentPlatformEvent) },
      source: {
        scope: 'PLATFORM',
        objectType: 'platform-operational-event',
        objectId: urgentPlatformEvent.id,
        tenantId: null,
        venueId: null,
      },
    }
  } else if (blockingQuestion) {
    focus = {
      kind: 'FOUNDER_QUESTION',
      urgency: 'HIGH',
      label: 'Founder decision',
      title: blockingQuestion.question,
      detail:
        blockingQuestion.context || `${blockingQuestion.agentIdentity.name} is waiting for input.`,
      action: { label: 'Answer here', href: '/admin/operations#needs-you-heading' },
      source: tenantSource(
        'agent-question',
        blockingQuestion.id,
        blockingQuestion.tenantId,
        blockingQuestion.venueId,
      ),
    }
  } else if (approval) {
    focus = {
      kind: 'APPROVAL',
      urgency: 'HIGH',
      label: 'Approval',
      title: approval.proposedAction,
      detail: `${approval.agentIdentity.name} · ${approval.riskCategory.toLowerCase()} risk`,
      action: { label: 'Make a decision', href: '/admin/operations#approval-attention-heading' },
      source: tenantSource('approval-request', approval.id, approval.tenantId, approval.venueId),
    }
  } else if (blockedRun) {
    focus = {
      kind: 'BLOCKED_WORK',
      urgency: 'NORMAL',
      label: 'Blocked work',
      title: blockedRun.requestedOperation,
      detail: `${blockedRun.agentIdentity.name} · ${blockedRun.status.replaceAll('_', ' ').toLowerCase()}`,
      action: {
        label: 'Inspect blocked run',
        href: blockedRun.venueId
          ? `/admin/clients/${blockedRun.tenantId}/venues/${blockedRun.venueId}/agents/runs/${blockedRun.id}`
          : `/admin/clients/${blockedRun.tenantId}`,
      },
      source: tenantSource('agent-run', blockedRun.id, blockedRun.tenantId, blockedRun.venueId),
    }
  } else if (support) {
    focus = {
      kind: 'CUSTOMER_SUPPORT',
      urgency: 'NORMAL',
      label: 'Customer attention',
      title: support.subject,
      detail: `${support.category.replaceAll('_', ' ').toLowerCase()} · ${support.status.replaceAll('_', ' ').toLowerCase()}`,
      action: {
        label: 'Review customer context',
        href: `/admin/clients/${support.tenantId}/venues/${support.venueId}/support-operations?requestId=${support.id}`,
      },
      source: tenantSource('support-request', support.id, support.tenantId, support.venueId),
    }
  } else {
    focus = {
      kind: 'CLEAR',
      urgency: 'NONE',
      label: 'No urgent founder action',
      title: 'The operating queues are clear.',
      detail:
        'No critical risk, blocking question, pending approval, blocked run, or support item is visible in this bounded snapshot.',
      action: { label: 'See what agents are doing', href: '/admin/operations#ai-workforce' },
      source: {
        scope: 'PLATFORM',
        objectType: 'attention-console',
        objectId: null,
        tenantId: null,
        venueId: null,
      },
    }
  }

  const pages = [
    input.events,
    input.platformEvents,
    input.questions,
    input.approvals,
    input.blockedAgents,
    input.support,
    input.workingAgents,
    input.completedAgents,
    input.outcomes,
  ]
  const afterReview = (value: Date) =>
    input.lastReviewedThrough === null || value > input.lastReviewedThrough
  const changesSinceLastReview = {
    criticalRisks:
      input.events.items.filter(
        (event) =>
          ['CRITICAL', 'ERROR'].includes(event.severity) && afterReview(event.lastOccurredAt),
      ).length +
      input.platformEvents.items.filter(
        (event) =>
          ['CRITICAL', 'ERROR'].includes(event.severity) && afterReview(event.lastOccurredAt),
      ).length,
    decisions:
      input.questions.items.filter((item) => afterReview(item.createdAt)).length +
      input.approvals.items.filter((item) => afterReview(item.createdAt)).length,
    completedAgents: input.completedAgents.items.filter((item) =>
      afterReview(item.completedAt ?? item.createdAt),
    ).length,
    outcomes: input.outcomes.items.filter((item) => afterReview(item.createdAt)).length,
    customerItems: input.support.items.filter((item) => afterReview(item.updatedAt)).length,
  }
  const changeDigest = deriveFounderChangeDigest({
    lastReviewedThrough: input.lastReviewedThrough,
    sourceHasMore: [
      input.events,
      input.platformEvents,
      input.questions,
      input.approvals,
      input.support,
      input.completedAgents,
      input.outcomes,
    ].some((value) => value.nextCursor !== null),
    events: input.events.items,
    platformEvents: input.platformEvents.items,
    questions: input.questions.items,
    approvals: input.approvals.items,
    support: input.support.items,
    completedAgents: input.completedAgents.items,
    outcomes: input.outcomes.items,
  })
  return {
    schemaVersion: 1 as const,
    focus,
    metrics: {
      decisions: input.questions.items.length + input.approvals.items.length,
      criticalRisks:
        input.events.items.filter((event) => ['CRITICAL', 'ERROR'].includes(event.severity))
          .length +
        input.platformEvents.items.filter((event) => ['CRITICAL', 'ERROR'].includes(event.severity))
          .length,
      workingAgents: input.workingAgents.items.length,
      customerItems: input.support.items.length,
    },
    boundedSnapshot: {
      limit: input.limit,
      hasMore: pages.some((value) => value.nextCursor !== null),
    },
    reviewState: {
      lastReviewedThrough: input.lastReviewedThrough,
      changesSinceLastReview,
      changeDigest,
      hasUnreviewedChanges: Object.values(changesSinceLastReview).some((value) => value > 0),
    },
  }
}
