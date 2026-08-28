export type TenantAttentionEvent = {
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
  occurrenceCount?: number
}

export type PlatformAttentionEvent = {
  id: string
  eventType: string
  severity: string
  title: string
  summary: string
  recommendedAction: string | null
  actionRequired: boolean
  lastOccurredAt: Date
  occurrenceCount?: number
}

type ActionRequiredEvent =
  | { scope: 'TENANT'; event: TenantAttentionEvent }
  | { scope: 'PLATFORM'; event: PlatformAttentionEvent }

export function tenantEventHref(event: TenantAttentionEvent) {
  if (event.eventType.startsWith('ai-cost-budget.')) {
    return `/admin/clients/${event.tenantId}#ai-cost-budget`
  }
  if (!event.venueId) return `/admin/clients/${event.tenantId}`
  if (event.eventType.startsWith('evaluation.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/evaluations`
  if (event.eventType.startsWith('knowledge.proposal.'))
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/knowledge-proposals`
  if (event.eventType.startsWith('customer-learning.first-week-'))
    return `/admin/clients/${event.tenantId}/analytics#first-week-reviews`
  return `/admin/clients/${event.tenantId}/venues/${event.venueId}/chatlogs`
}

export function platformEventHref(event: PlatformAttentionEvent) {
  if (event.eventType.startsWith('crm.import.')) return '/admin/prospects/imports'
  if (event.eventType.startsWith('crm.duplicate.')) return '/admin/prospects/duplicates'
  if (event.eventType.startsWith('crm.')) return '/admin/prospects'
  return '/admin/operations#alerts'
}

function actionRequiredRank({ event }: ActionRequiredEvent) {
  if (event.eventType === 'billing.payment-failed') return 0
  if (event.eventType === 'crm.reply.received') return 1
  if (event.eventType.startsWith('customer-learning.first-week-')) return 2
  if (event.severity === 'WARNING') return 3
  return 4
}

export function selectActionRequiredEvent(input: {
  events: TenantAttentionEvent[]
  platformEvents: PlatformAttentionEvent[]
}) {
  return [
    ...input.events
      .filter((event) => event.actionRequired && !['CRITICAL', 'ERROR'].includes(event.severity))
      .map((event) => ({ scope: 'TENANT' as const, event })),
    ...input.platformEvents
      .filter((event) => event.actionRequired && !['CRITICAL', 'ERROR'].includes(event.severity))
      .map((event) => ({ scope: 'PLATFORM' as const, event })),
  ].sort((left, right) => {
    const rank = actionRequiredRank(left) - actionRequiredRank(right)
    if (rank !== 0) return rank
    const recency = right.event.lastOccurredAt.getTime() - left.event.lastOccurredAt.getTime()
    if (recency !== 0) return recency
    return left.event.id.localeCompare(right.event.id)
  })[0]
}

export function actionRequiredLabel(event: TenantAttentionEvent | PlatformAttentionEvent) {
  if (event.eventType === 'billing.payment-failed') return 'Customer payment'
  if (event.eventType === 'crm.reply.received') return 'Prospect reply'
  if (event.eventType.startsWith('customer-learning.first-week-')) return 'Customer learning'
  return 'Operational attention'
}
