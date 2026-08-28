import { classifyFounderOperatingIntent } from './founder-operating-intent'

export { classifyFounderOperatingIntent } from './founder-operating-intent'

type Source = {
  scope: 'PLATFORM' | 'TENANT'
  objectType: string
  objectId: string | null
  tenantId: string | null
  venueId: string | null
}

type Evidence = Source & {
  label: string
  detail: string
  href: string
}

type Page<T> = { items: T[]; nextCursor: unknown | null }

export type FounderConversationSource = {
  generatedAt: Date
  briefing: {
    focus: {
      kind: string
      label: string
      title: string
      detail: string
      action: { label: string; href: string }
      source: Source
    }
    metrics: {
      decisions: number
      criticalRisks: number
      workingAgents: number
      customerItems: number
      actionItems: number
    }
    boundedSnapshot: { limit: number; hasMore: boolean }
    reviewState: {
      changesSinceLastReview: {
        criticalRisks: number
        decisions: number
        completedAgents: number
        outcomes: number
        customerItems: number
        attentionItems: number
      }
      changeDigest: {
        items: Array<{
          title: string
          detail: string
          action: { href: string }
          source: Source
        }>
        mayHaveMore: boolean
      }
    }
  }
  questions: Page<{
    id: string
    tenantId: string
    venueId: string
    question: string
    context: string | null
  }>
  approvals: Page<{
    id: string
    tenantId: string
    venueId: string | null
    proposedAction: string
    riskCategory: string
    expired: boolean
  }>
  events: Page<{
    id: string
    tenantId: string
    venueId: string | null
    eventType: string
    severity: string
    title: string
    summary: string
    recommendedAction: string | null
  }>
  platformEvents: Page<{
    id: string
    severity: string
    title: string
    summary: string
    recommendedAction: string | null
  }>
  workingAgents: Page<{
    id: string
    tenantId: string
    venueId: string | null
    requestedOperation: string
    status: string
    agentIdentity: { name: string }
  }>
  blockedAgents: Page<{
    id: string
    tenantId: string
    venueId: string | null
    requestedOperation: string
    status: string
    agentIdentity: { name: string }
  }>
  support: Page<{
    id: string
    tenantId: string
    venueId: string
    subject: string
    category: string
    status: string
  }>
  unitEconomics: {
    window: { days: number }
    totals: {
      knownOperatingCostUsd: string
      priorKnownOperatingCostUsd: string
      changeUsd: string
    }
    coverage: { complete: boolean; interpretation: string }
  }
}

function tenantHref(tenantId: string, venueId: string | null, suffix = '') {
  const base = venueId
    ? `/admin/clients/${tenantId}/venues/${venueId}`
    : `/admin/clients/${tenantId}`
  return `${base}${suffix}`
}

function tenantEventHref(event: FounderConversationSource['events']['items'][number]) {
  if (event.eventType.startsWith('ai-cost-budget.')) {
    return `/admin/clients/${event.tenantId}#ai-cost-budget`
  }
  if (event.eventType.startsWith('customer-learning.first-week-')) {
    return `/admin/clients/${event.tenantId}/analytics#first-week-reviews`
  }
  if (!event.venueId) return `/admin/clients/${event.tenantId}`
  if (event.eventType.startsWith('evaluation.')) {
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/evaluations`
  }
  if (event.eventType.startsWith('knowledge.proposal.')) {
    return `/admin/clients/${event.tenantId}/venues/${event.venueId}/knowledge-proposals`
  }
  return `/admin/clients/${event.tenantId}/venues/${event.venueId}/chatlogs`
}

function evidence(label: string, detail: string, href: string, source: Source): Evidence {
  return { label, detail, href, ...source }
}

function source(
  objectType: string,
  objectId: string | null,
  tenantId: string | null,
  venueId: string | null,
): Source {
  return {
    scope: tenantId === null ? 'PLATFORM' : 'TENANT',
    objectType,
    objectId,
    tenantId,
    venueId,
  }
}

export function deriveFounderOperatingExchange(prompt: string, input: FounderConversationSource) {
  const intent = classifyFounderOperatingIntent(prompt)
  let responseTitle: string
  let responseBody: string
  let items: Evidence[] = []

  if (intent === 'TOP_PRIORITY') {
    const focus = input.briefing.focus
    responseTitle = focus.label
    responseBody = `${focus.title} ${focus.detail}`
    items = [evidence(focus.action.label, focus.detail, focus.action.href, focus.source)]
  } else if (intent === 'DECISIONS') {
    const count = input.questions.items.length + input.approvals.items.length
    responseTitle =
      count === 0
        ? 'No visible founder decisions'
        : `${count} founder decision${count === 1 ? '' : 's'} visible`
    responseBody =
      count === 0
        ? 'No pending questions or approvals are visible in this bounded snapshot.'
        : `${input.questions.items.length} question${input.questions.items.length === 1 ? '' : 's'} and ${input.approvals.items.length} approval${input.approvals.items.length === 1 ? '' : 's'} need review.`
    items = [
      ...input.questions.items.map((item) =>
        evidence(
          item.question,
          item.context || 'An operating worker is waiting for founder judgment.',
          '/admin/operations#needs-you-heading',
          source('agent-question', item.id, item.tenantId, item.venueId),
        ),
      ),
      ...input.approvals.items.map((item) =>
        evidence(
          item.proposedAction,
          item.expired
            ? 'The approval window has expired.'
            : `${item.riskCategory.toLowerCase()} risk approval`,
          '/admin/operations#approval-attention-heading',
          source('approval-request', item.id, item.tenantId, item.venueId),
        ),
      ),
    ]
  } else if (intent === 'INCIDENTS') {
    const tenantEvents = input.events.items.filter((item) =>
      ['CRITICAL', 'ERROR'].includes(item.severity),
    )
    const platformEvents = input.platformEvents.items.filter((item) =>
      ['CRITICAL', 'ERROR'].includes(item.severity),
    )
    const count = tenantEvents.length + platformEvents.length
    responseTitle =
      count === 0
        ? 'No critical incidents visible'
        : `${count} critical incident${count === 1 ? '' : 's'} visible`
    responseBody =
      count === 0
        ? 'No open critical or error event is visible in this bounded snapshot.'
        : 'Customer-facing and platform risks are listed in priority order below.'
    items = [
      ...tenantEvents.map((item) =>
        evidence(
          item.title,
          item.recommendedAction || item.summary,
          tenantEventHref(item),
          source('operational-event', item.id, item.tenantId, item.venueId),
        ),
      ),
      ...platformEvents.map((item) =>
        evidence(
          item.title,
          item.recommendedAction || item.summary,
          '/admin/operations#alerts',
          source('platform-operational-event', item.id, null, null),
        ),
      ),
    ]
  } else if (intent === 'AGENT_ACTIVITY') {
    const working = input.workingAgents.items.length
    const blocked = input.blockedAgents.items.length
    responseTitle = `${working} working · ${blocked} blocked`
    responseBody =
      blocked > 0
        ? `${blocked} operating worker${blocked === 1 ? ' is' : 's are'} waiting on input, approval, or recovery.`
        : working > 0
          ? 'Visible operating workers are progressing without a blocked run.'
          : 'No working or blocked operating runs are visible in this bounded snapshot.'
    items = [...input.blockedAgents.items, ...input.workingAgents.items].map((item) =>
      evidence(
        `${item.agentIdentity.name} · ${item.status.replaceAll('_', ' ').toLowerCase()}`,
        item.requestedOperation,
        tenantHref(item.tenantId, item.venueId, item.venueId ? `/agents/runs/${item.id}` : ''),
        source('agent-run', item.id, item.tenantId, item.venueId),
      ),
    )
  } else if (intent === 'CUSTOMER_ISSUES') {
    const risks = input.events.items.filter((item) => ['CRITICAL', 'ERROR'].includes(item.severity))
    const count = input.support.items.length + risks.length
    responseTitle =
      count === 0
        ? 'No customer issue visible'
        : `${count} customer item${count === 1 ? '' : 's'} visible`
    responseBody =
      count === 0
        ? 'No active support request or critical tenant event is visible in this bounded snapshot.'
        : `${risks.length} critical customer risk${risks.length === 1 ? '' : 's'} and ${input.support.items.length} active support request${input.support.items.length === 1 ? '' : 's'} are visible.`
    items = [
      ...risks.map((item) =>
        evidence(
          item.title,
          item.recommendedAction || item.summary,
          tenantEventHref(item),
          source('operational-event', item.id, item.tenantId, item.venueId),
        ),
      ),
      ...input.support.items.map((item) =>
        evidence(
          item.subject,
          `${item.category.replaceAll('_', ' ').toLowerCase()} · ${item.status.replaceAll('_', ' ').toLowerCase()}`,
          tenantHref(item.tenantId, item.venueId, `/support-operations?requestId=${item.id}`),
          source('support-request', item.id, item.tenantId, item.venueId),
        ),
      ),
    ]
  } else if (intent === 'CHANGES') {
    const digest = input.briefing.reviewState.changeDigest
    responseTitle =
      digest.items.length === 0
        ? 'No new change visible'
        : `${digest.items.length} recent change${digest.items.length === 1 ? '' : 's'}`
    responseBody =
      digest.items.length === 0
        ? 'No unreviewed change is visible in this bounded snapshot.'
        : digest.mayHaveMore
          ? 'These are the highest-priority changes; the bounded source may contain more.'
          : 'These are the visible changes since the last founder review.'
    items = digest.items.map((item) =>
      evidence(item.title, item.detail, item.action.href, item.source),
    )
  } else if (intent === 'COSTS') {
    const costs = input.unitEconomics
    responseTitle = `$${costs.totals.knownOperatingCostUsd} known operating cost`
    responseBody = `The ${costs.window.days}-day bounded total changed by $${costs.totals.changeUsd} from $${costs.totals.priorKnownOperatingCostUsd}. Coverage is ${costs.coverage.complete ? 'complete for declared categories' : 'incomplete'}, and no automatic anomaly threshold has been settled.`
    items = [
      evidence(
        'Review operating-cost evidence',
        costs.coverage.interpretation,
        '/admin/operations#cost-coverage',
        source('founder-unit-economics', null, null, null),
      ),
    ]
  } else {
    responseTitle = 'Direction recorded for triage'
    responseBody =
      'This direction is now visible to authorized platform operating workers. Nothing was executed, approved, sent to a customer, priced, billed, deployed, purchased, or adopted as policy.'
  }

  return {
    intent,
    disposition: intent === 'DIRECTIVE' ? ('RECORDED_FOR_TRIAGE' as const) : ('ANSWERED' as const),
    responseTitle,
    responseBody,
    evidence: items.slice(0, 5),
    snapshot: {
      schemaVersion: 1 as const,
      generatedAt: input.generatedAt.toISOString(),
      boundedSnapshot: input.briefing.boundedSnapshot,
      metrics: {
        ...input.briefing.metrics,
        blockedAgents: input.blockedAgents.items.length,
      },
      changesSinceLastReview: input.briefing.reviewState.changesSinceLastReview,
      operatingCosts: {
        windowDays: input.unitEconomics.window.days,
        knownOperatingCostUsd: input.unitEconomics.totals.knownOperatingCostUsd,
        priorKnownOperatingCostUsd: input.unitEconomics.totals.priorKnownOperatingCostUsd,
        changeUsd: input.unitEconomics.totals.changeUsd,
        coverageComplete: input.unitEconomics.coverage.complete,
        anomalyThreshold: 'UNRESOLVED' as const,
      },
      authority: {
        canExecute: false as const,
        canApprove: false as const,
        canContactCustomers: false as const,
        canChangePricing: false as const,
        canSpendMoney: false as const,
        canMutatePolicy: false as const,
      },
    },
  }
}
