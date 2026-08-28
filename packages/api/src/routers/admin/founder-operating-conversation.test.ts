import { describe, expect, it } from 'vitest'

import {
  classifyFounderOperatingIntent,
  deriveFounderOperatingExchange,
  type FounderConversationSource,
} from './founder-operating-conversation'

function fixture(): FounderConversationSource {
  return {
    generatedAt: new Date('2026-08-25T12:00:00.000Z'),
    briefing: {
      focus: {
        kind: 'FOUNDER_QUESTION',
        label: 'Founder decision',
        title: 'Choose a customer exception',
        detail: 'Hermes is waiting for judgment.',
        action: { label: 'Answer here', href: '/admin/operations#needs-you-heading' },
        source: {
          scope: 'TENANT',
          objectType: 'agent-question',
          objectId: 'question_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        },
      },
      metrics: {
        decisions: 2,
        criticalRisks: 1,
        workingAgents: 1,
        customerItems: 1,
        actionItems: 2,
      },
      boundedSnapshot: { limit: 10, hasMore: false },
      reviewState: {
        changesSinceLastReview: {
          criticalRisks: 1,
          decisions: 2,
          completedAgents: 1,
          outcomes: 1,
          customerItems: 1,
          attentionItems: 1,
        },
        changeDigest: {
          mayHaveMore: false,
          items: [
            {
              title: 'A customer needs attention',
              detail: 'Support request is open.',
              action: { href: '/admin/clients/tenant_1' },
              source: {
                scope: 'TENANT',
                objectType: 'support-request',
                objectId: 'support_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
            },
          ],
        },
      },
    },
    questions: {
      nextCursor: null,
      items: [
        {
          id: 'question_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          question: 'Choose a customer exception',
          context: 'Hermes is waiting for judgment.',
        },
      ],
    },
    approvals: {
      nextCursor: null,
      items: [
        {
          id: 'approval_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          proposedAction: 'Apply a lifecycle transition',
          riskCategory: 'HIGH',
          expired: false,
        },
      ],
    },
    events: {
      nextCursor: null,
      items: [
        {
          id: 'event_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          eventType: 'guest-chat.provider-failure',
          severity: 'CRITICAL',
          title: 'Visitor answers are failing',
          summary: 'Provider calls are failing.',
          recommendedAction: 'Use the established provider fallback.',
        },
      ],
    },
    platformEvents: { items: [], nextCursor: null },
    workingAgents: {
      nextCursor: null,
      items: [
        {
          id: 'run_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          requestedOperation: 'Reconcile customer context',
          status: 'RUNNING',
          agentIdentity: { name: 'Hermes' },
        },
      ],
    },
    blockedAgents: { items: [], nextCursor: null },
    support: {
      nextCursor: null,
      items: [
        {
          id: 'support_1',
          tenantId: 'tenant_1',
          venueId: 'venue_1',
          subject: 'Hours need correction',
          category: 'CONTENT_CHANGE',
          status: 'OPEN',
        },
      ],
    },
    unitEconomics: {
      window: { days: 30 },
      totals: {
        knownOperatingCostUsd: '12.00000000',
        priorKnownOperatingCostUsd: '10.00000000',
        changeUsd: '2.00000000',
      },
      coverage: { complete: false, interpretation: 'Only evidenced costs are summed.' },
    },
  }
}

describe('founder operating conversation', () => {
  it.each([
    ['What is the highest-value thing I can do in the next five minutes?', 'TOP_PRIORITY'],
    ['What needs my decision?', 'DECISIONS'],
    ['Is anything broken?', 'INCIDENTS'],
    ['What are agents waiting on?', 'AGENT_ACTIVITY'],
    ['Which agent approvals need my decision?', 'DECISIONS'],
    ['Are there customer support issues?', 'CUSTOMER_ISSUES'],
    ['What changed since my last review?', 'CHANGES'],
    ['Show me anything costing unexpectedly much.', 'COSTS'],
    ['Do outreach for another group of venues.', 'DIRECTIVE'],
  ])('classifies %s', (prompt, expected) => {
    expect(classifyFounderOperatingIntent(prompt)).toBe(expected)
  })

  it('answers from canonical focus with an exact evidence link and no authority', () => {
    const result = deriveFounderOperatingExchange(
      'What is the highest-value thing I can do in the next five minutes?',
      fixture(),
    )
    expect(result).toMatchObject({
      intent: 'TOP_PRIORITY',
      disposition: 'ANSWERED',
      responseTitle: 'Founder decision',
      evidence: [{ objectType: 'agent-question', objectId: 'question_1' }],
      snapshot: {
        metrics: { decisions: 2, blockedAgents: 0 },
        authority: {
          canExecute: false,
          canApprove: false,
          canContactCustomers: false,
          canChangePricing: false,
          canSpendMoney: false,
          canMutatePolicy: false,
        },
      },
    })
  })

  it('records unmatched direction for triage without claiming execution', () => {
    const result = deriveFounderOperatingExchange(
      'Outreach to the next Las Vegas segment.',
      fixture(),
    )
    expect(result).toMatchObject({
      intent: 'DIRECTIVE',
      disposition: 'RECORDED_FOR_TRIAGE',
      evidence: [],
    })
    expect(result.responseBody).toContain('Nothing was executed')
    expect(result.responseBody).toContain('sent to a customer')
  })

  it('states cost evidence incompleteness and unresolved anomaly policy', () => {
    const result = deriveFounderOperatingExchange('What are our costs?', fixture())
    expect(result.responseTitle).toContain('$12.00000000')
    expect(result.responseBody).toContain('Coverage is incomplete')
    expect(result.responseBody).toContain('no automatic anomaly threshold')
    expect(result.snapshot.operatingCosts.anomalyThreshold).toBe('UNRESOLVED')
  })

  it('bounds evidence even when a source page contains more items', () => {
    const data = fixture()
    data.questions.items = Array.from({ length: 7 }, (_, index) => ({
      id: `question_${index}`,
      tenantId: 'tenant_1',
      venueId: 'venue_1',
      question: `Question ${index}`,
      context: null,
    }))
    expect(deriveFounderOperatingExchange('What needs my decision?', data).evidence).toHaveLength(5)
  })
})
