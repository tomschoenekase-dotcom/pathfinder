/* @vitest-environment jsdom */
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('../../lib/trpc', () => ({
  useTRPCClient: () => ({
    admin: { executeApprovedCustomerInvitation: { mutate: vi.fn() } },
  }),
}))
vi.mock('./OperationalEventActions', () => ({
  OperationalEventActions: () => <span>Event actions</span>,
}))
vi.mock('./AgentQuestionAnswerForm', () => ({
  AgentQuestionAnswerForm: () => <span>Inline question answer</span>,
}))
vi.mock('./ApprovalDecisionForm', () => ({
  ApprovalDecisionForm: () => <span>Inline approval decision</span>,
}))
vi.mock('./FounderBriefingReviewForm', () => ({
  FounderBriefingReviewForm: () => <span>Review checkpoint control</span>,
}))
vi.mock('./TerminalRedrivePreview', () => ({
  TerminalRedrivePreview: () => <span>Recovery preview control</span>,
}))
vi.mock('./GuestChatIncidentEvidence', () => ({
  GuestChatIncidentEvidence: () => <span>Guest chat incident evidence control</span>,
}))

import { OperationsAttentionConsole } from './OperationsAttentionConsole'
;(globalThis as typeof globalThis & { React: typeof React }).React = React

type Data = React.ComponentProps<typeof OperationsAttentionConsole>['data']

const empty: Data = {
  generatedAt: new Date('2026-08-11T14:30:00.000Z'),
  jobs: { items: [], nextCursor: null },
  evaluations: { items: [], nextCursor: null },
  approvals: { items: [], nextCursor: null },
  support: { items: [], nextCursor: null },
  agents: { items: [], nextCursor: null },
  questions: { items: [], nextCursor: null },
  workingAgents: { items: [], nextCursor: null },
  blockedAgents: { items: [], nextCursor: null },
  completedAgents: { items: [], nextCursor: null },
  outcomes: { items: [], nextCursor: null },
  events: { items: [], nextCursor: null },
  platformEvents: { items: [], nextCursor: null },
  founderConversation: [],
  workers: [],
  unitEconomics: {
    schemaVersion: 'founder-unit-economics.v1',
    generatedAt: new Date('2026-08-11T14:30:00.000Z'),
    window: {
      days: 30,
      start: new Date('2026-07-12T14:30:00.000Z'),
      endExclusive: new Date('2026-08-11T14:30:00.000Z'),
      previousStart: new Date('2026-06-12T14:30:00.000Z'),
    },
    totals: {
      knownOperatingCostUsd: '0.00000000',
      priorKnownOperatingCostUsd: '0.00000000',
      changeUsd: '0.00000000',
      changePercent: null,
    },
    ai: {
      estimatedCostUsd: '0.00000000',
      requestCount: 0,
      attributedTenantCount: 0,
      completeness: 'PROVIDER_PRICING_ESTIMATE',
    },
    nonAi: {
      evidencedCostUsd: '0.00000000',
      platformUnallocatedUsd: '0.00000000',
      tenantOrVenueAttributedUsd: '0.00000000',
      evidenceCount: 0,
      excludedOverlappingEvidenceCount: 0,
      categories: [],
    },
    operationalUsage: {
      interpretation: 'Latest measured quantities are not provider invoices or dollar costs.',
      rowsReturned: 0,
      truncated: false,
      freshness: { declaredUsageDays: 2, queueUsageMinutes: 60 },
      metrics: [
        {
          metric: 'INTAKE_DECLARED_BYTES',
          represented: false,
          quantity: '0',
          unit: null,
          scopeCount: 0,
          latestObservedAt: null,
          sourceSystems: [],
        },
        {
          metric: 'MEDIA_DECLARED_BYTES',
          represented: false,
          quantity: '0',
          unit: null,
          scopeCount: 0,
          latestObservedAt: null,
          sourceSystems: [],
        },
        {
          metric: 'QUEUE_DEPTH',
          represented: false,
          quantity: '0',
          unit: null,
          scopeCount: 0,
          latestObservedAt: null,
          sourceSystems: [],
        },
        {
          metric: 'QUEUE_FAILED_JOBS',
          represented: false,
          quantity: '0',
          unit: null,
          scopeCount: 0,
          latestObservedAt: null,
          sourceSystems: [],
        },
        {
          metric: 'QUEUE_OLDEST_AGE_MILLISECONDS',
          represented: false,
          quantity: '0',
          unit: null,
          scopeCount: 0,
          latestObservedAt: null,
          sourceSystems: [],
        },
      ],
      representedMetrics: [],
      unrepresentedMetrics: [
        'INTAKE_DECLARED_BYTES',
        'MEDIA_DECLARED_BYTES',
        'QUEUE_DEPTH',
        'QUEUE_FAILED_JOBS',
        'QUEUE_OLDEST_AGE_MILLISECONDS',
      ],
      assignsDollarValue: false,
      definesAnomalyThreshold: false,
    },
    coverage: {
      representedCategories: [],
      unrepresentedCategories: [
        'STORAGE',
        'EMAIL',
        'MEDIA_PROCESSING',
        'INFRASTRUCTURE',
        'OBSERVABILITY',
        'SECURITY',
        'BANDWIDTH',
        'OPERATOR_TIME',
        'OTHER',
      ],
      complete: false,
      interpretation: 'Only current evidence wholly contained in the window is summed.',
    },
    policy: {
      anomalyThreshold: 'UNRESOLVED',
      anomalyClassification: 'NOT_COMPUTED',
      affectsInvoices: false,
      affectsCustomerPricing: false,
      authorizesServiceCutoff: false,
    },
  },
  agentTrustEvidence: {
    schemaVersion: 3,
    state: 'NO_OUTCOME_EVIDENCE',
    verdicts: { positive: 0, mixed: 0, negative: 0, inconclusive: 0 },
    observations: 0,
    distinctObservedRuns: 0,
    completedRuns: { visible: 0, withObservation: 0, withoutObservation: 0 },
    runs: { visible: 0, completed: 0, failed: 0 },
    actions: { visible: 0, succeeded: 0, failed: 0, denied: 0, cancelled: 0 },
    approvalDecisions: {
      visible: 0,
      approved: 0,
      rejected: 0,
      cancelled: 0,
      expired: 0,
      acceptance: { numerator: 0, denominator: 0, rate: null, excludes: ['CANCELLED', 'EXPIRED'] },
    },
    qualityEvaluations: { positive: 0, mixed: 0, negative: 0, inconclusive: 0 },
    customerSignals: { positive: 0, mixed: 0, negative: 0, inconclusive: 0 },
    rollbackEvidence: {
      observations: 0,
      distinctActions: 0,
      succeededActionDenominator: 0,
      rate: null,
      completeWindow: true,
    },
    policyViolationEvidence: {
      observations: 0,
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
      policyCodes: [],
    },
    confidenceCalibration: {
      observations: 0,
      correct: 0,
      incorrect: 0,
      meanPredictedConfidence: null,
      observedAccuracy: null,
      brierScore: null,
      completeWindow: true,
    },
    taskClasses: [],
    signalKinds: [],
    byAgent: [],
    evidenceCoverage: {
      executionRuns: 'AVAILABLE',
      explicitOutcomes: 'AVAILABLE',
      toolActions: 'AVAILABLE',
      approvalAcceptance: 'AVAILABLE',
      deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION',
      rollbackRate: 'AVAILABLE_COMPLETE_WINDOW',
      policyViolations: 'AVAILABLE_CANONICAL_SIGNAL',
      confidenceCalibration: 'AVAILABLE_CANONICAL_PREDICTION_OUTCOME_PAIR',
    },
    boundedSnapshot: { hasMore: false },
    policy: {
      approvalReductionRecommended: false,
      explanation:
        'Completion alone is not quality evidence. Record explicit outcomes before considering any change to approval policy.',
    },
  },
  briefing: {
    schemaVersion: 2,
    focus: {
      kind: 'CLEAR',
      urgency: 'NONE',
      label: 'No urgent founder action',
      title: 'The operating queues are clear.',
      detail: 'No urgent work is visible.',
      action: { label: 'See what agents are doing', href: '/admin/operations#ai-workforce' },
      source: {
        scope: 'PLATFORM',
        objectType: 'attention-console',
        objectId: null,
        tenantId: null,
        venueId: null,
      },
      decisionContext: {
        attentionReason: 'No founder-attention item is visible in the bounded queues.',
        consequence: 'No visible founder-attention item is waiting.',
        observedAt: null,
        deadline: null,
        occurrenceCount: 0,
        founderResponseRequiredToProceed: false,
      },
    },
    metrics: {
      decisions: 0,
      criticalRisks: 0,
      workingAgents: 0,
      customerItems: 0,
      actionItems: 0,
    },
    boundedSnapshot: { limit: 10, hasMore: false },
    reviewState: {
      lastReviewedThrough: null,
      changesSinceLastReview: {
        criticalRisks: 0,
        decisions: 0,
        completedAgents: 0,
        outcomes: 0,
        customerItems: 0,
        attentionItems: 0,
      },
      changeDigest: { limit: 5, visibleCount: 0, mayHaveMore: false, items: [] },
      hasUnreviewedChanges: false,
    },
  },
}

describe('operations attention console', () => {
  afterEach(cleanup)

  it('renders honest empty states for every bounded queue', () => {
    render(<OperationsAttentionConsole data={empty} />)
    expect(screen.getByText('No failed job records need attention.')).toBeTruthy()
    expect(screen.getByText(/No evaluation runs currently match/)).toBeTruthy()
    expect(screen.getByText('No undecided approval requests are recorded.')).toBeTruthy()
    expect(screen.getByText(/No support requests currently match/)).toBeTruthy()
    expect(screen.getByText('No agents are waiting for human input.')).toBeTruthy()
    expect(screen.getByText('No agent work is queued or running.')).toBeTruthy()
    expect(screen.getByText('No agent runs are blocked or failed.')).toBeTruthy()
    expect(screen.getByText('No completed agent runs are recorded.')).toBeTruthy()
    expect(screen.getByText('No outcome observations are recorded yet.')).toBeTruthy()
    expect(screen.getByText(/review linked evidence/i)).toBeTruthy()
    expect(screen.getByText('No operational alerts currently need attention.')).toBeTruthy()
    expect(screen.getByText('No platform CRM alerts currently need attention.')).toBeTruthy()
    expect(screen.getByText('No compatible workers have registered.')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Your next five minutes' })).toBeTruthy()
    expect(screen.getByText('The operating queues are clear.')).toBeTruthy()
    expect(screen.getByText('Since your last review')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeTruthy()
    expect(screen.getByText(/first recorded review/i)).toBeTruthy()
    expect(screen.getByText('Review checkpoint control')).toBeTruthy()
    expect(
      screen.getByRole('heading', { name: 'Has the AI workforce earned more trust?' }),
    ).toBeTruthy()
    expect(screen.getByText(/Completion alone is not quality evidence/)).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'What is costing Torchiko money?' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Measured operational load' })).toBeTruthy()
    expect(screen.getByText(/No recent queue or declared-byte observations/)).toBeTruthy()
    expect(screen.getByText('Coverage incomplete')).toBeTruthy()
    expect(screen.getByText(/No anomaly threshold is settled/)).toBeTruthy()
    expect(
      screen.getByText(/No reliability score, trend claim, or permission change is inferred/),
    ).toBeTruthy()
  })

  it('surfaces negative trust evidence without recommending broader authority and passes axe', async () => {
    const { container } = render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          agentTrustEvidence: {
            ...empty.agentTrustEvidence,
            state: 'NEGATIVE_EVIDENCE_PRESENT',
            verdicts: { positive: 2, mixed: 1, negative: 1, inconclusive: 0 },
            observations: 4,
            distinctObservedRuns: 3,
            completedRuns: { visible: 4, withObservation: 3, withoutObservation: 1 },
            taskClasses: ['support'],
            signalKinds: ['HUMAN_REVIEW', 'QUALITY_EVALUATION'],
            boundedSnapshot: { hasMore: true },
            policy: {
              approvalReductionRecommended: false,
              explanation:
                'Negative evidence is present. Inspect the underlying runs and corrections; this snapshot does not support reducing approval.',
            },
          },
        }}
      />,
    )

    expect(screen.getByText('negative evidence present')).toBeTruthy()
    expect(screen.getByText(/does not support reducing approval/)).toBeTruthy()
    expect(screen.getByText('additional evidence exists', { exact: false })).toBeTruthy()
    expect(
      (await axe.run(container, { rules: { 'color-contrast': { enabled: false } } })).violations,
    ).toEqual([])
  })

  it('puts human questions first and links to the durable agent inbox', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          questions: {
            items: [
              {
                id: 'question_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                agentRunId: 'run_1',
                question: 'Which pricing assumption should I use?',
                context: 'Two sources disagree.',
                questionType: 'MULTIPLE_CHOICE',
                category: 'pricing',
                urgency: 'HIGH',
                choices: ['Current list price', 'Last signed agreement'],
                dueAt: null,
                evidence: [],
                proposedAnswer: null,
                blocking: true,
                createdAt: new Date(),
                updatedAt: new Date(),
                agentIdentity: { name: 'Research' },
                agentRun: { id: 'run_1', status: 'AWAITING_INPUT', requestedOperation: 'pricing' },
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'FOUNDER_QUESTION',
              urgency: 'HIGH',
              label: 'Founder decision',
              title: 'Which pricing assumption should I use?',
              detail: 'Two sources disagree.',
              action: { label: 'Answer here', href: '/admin/operations#needs-you-heading' },
              source: {
                scope: 'TENANT',
                objectType: 'agent-question',
                objectId: 'question_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
              decisionContext: {
                attentionReason: 'A blocking question is waiting for founder judgment.',
                consequence: 'The linked agent run cannot proceed past this question.',
                observedAt: new Date('2026-08-25T11:00:00.000Z'),
                deadline: null,
                occurrenceCount: 1,
                founderResponseRequiredToProceed: true,
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1 },
          },
        }}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeTruthy()
    expect(screen.getAllByText('Which pricing assumption should I use?')).toHaveLength(2)
    expect(screen.getByText('Required for this work to proceed')).toBeTruthy()
    expect(screen.getByText('Inline question answer')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open full agent context' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/agents#inbox',
    )
  })

  it('surfaces a critical customer event ahead of routine decisions', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          questions: {
            items: [
              {
                id: 'question_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                agentRunId: 'run_1',
                question: 'Can this wait?',
                context: null,
                questionType: 'YES_NO',
                category: 'operations',
                urgency: 'NORMAL',
                choices: ['Yes', 'No'],
                dueAt: null,
                evidence: [],
                proposedAnswer: null,
                blocking: true,
                createdAt: new Date(),
                updatedAt: new Date(),
                agentIdentity: { name: 'Operator' },
                agentRun: { id: 'run_1', status: 'AWAITING_INPUT', requestedOperation: 'review' },
              },
            ],
            nextCursor: null,
          },
          events: {
            items: [
              {
                id: 'event_critical',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'guest-chat.provider-failure',
                sourceSubsystem: 'guest-chat',
                severity: 'CRITICAL',
                title: 'Visitor chat is unavailable',
                summary: 'Guest questions are failing.',
                recommendedAction: 'Inspect the affected chat turns.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'guest-chat-turn',
                linkedObjectId: 'turn_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'CUSTOMER_RISK',
              urgency: 'CRITICAL',
              label: 'Customer or system risk',
              title: 'Visitor chat is unavailable',
              detail: 'Inspect the affected chat turns.',
              action: {
                label: 'Review risk now',
                href: '/admin/clients/tenant_1/venues/venue_1/chatlogs',
              },
              source: {
                scope: 'TENANT',
                objectType: 'operational-event',
                objectId: 'event_critical',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
              decisionContext: {
                attentionReason:
                  'An open action-required event is recorded at critical or error severity.',
                consequence: 'The recorded risk remains unresolved until it is reviewed.',
                observedAt: new Date('2026-08-25T11:00:00.000Z'),
                deadline: null,
                occurrenceCount: 3,
                founderResponseRequiredToProceed: false,
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1, criticalRisks: 1 },
          },
        }}
      />,
    )

    const briefing = screen.getByRole('heading', { name: 'Your next five minutes' }).parentElement
    expect(briefing?.textContent).toContain('Visitor chat is unavailable')
    expect(screen.getByText('3 recorded occurrences')).toBeTruthy()
    expect(screen.getByText('No response gate is recorded')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Review risk now' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/chatlogs',
    )
  })

  it('puts an unexpired venue approval directly in the founder decision flow', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          approvals: {
            items: [
              {
                id: 'approval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                proposedAction: 'Apply reviewed hours update',
                riskCategory: 'MEDIUM',
                expiresAt: new Date('2099-01-01T00:00:00.000Z'),
                createdAt: new Date(),
                agentIdentity: { name: 'Support operator' },
                customerAccessRequest: null,
                founderDirectiveTask: null,
                expired: false,
              },
            ],
            nextCursor: null,
          },
          briefing: {
            ...empty.briefing,
            focus: {
              kind: 'APPROVAL',
              urgency: 'HIGH',
              label: 'Approval',
              title: 'Apply reviewed hours update',
              detail: 'Support operator · medium risk',
              action: {
                label: 'Make a decision',
                href: '/admin/operations#approval-attention-heading',
              },
              source: {
                scope: 'TENANT',
                objectType: 'approval-request',
                objectId: 'approval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
              },
              decisionContext: {
                attentionReason:
                  'A proposed action is waiting for an explicit human approval decision.',
                consequence:
                  'The proposed action remains unexecuted until a human decision is recorded.',
                observedAt: new Date('2026-08-25T11:00:00.000Z'),
                deadline: { at: new Date('2099-01-01T00:00:00.000Z'), kind: 'EXPIRES' },
                occurrenceCount: 1,
                founderResponseRequiredToProceed: true,
              },
            },
            metrics: { ...empty.briefing.metrics, decisions: 1 },
          },
        }}
      />,
    )

    expect(screen.getByText('Inline approval decision')).toBeTruthy()
    expect(screen.getByText('Approval expires')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Make a decision' }).getAttribute('href')).toBe(
      '/admin/operations#approval-attention-heading',
    )
    expect(
      screen.getByRole('link', { name: 'Open full approval context' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/agents#approvals')
  })

  it('shows the exact founder direction, proposed task, and retained constraints', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          approvals: {
            items: [
              {
                id: 'approval_directive',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                proposedAction: 'torchiko.founder-directive.materialize-task',
                riskCategory: 'LOW',
                expiresAt: null,
                createdAt: new Date(),
                agentIdentity: { name: 'Operations specialist' },
                customerAccessRequest: null,
                founderDirectiveTask: {
                  id: 'request_directive',
                  status: 'AWAITING_APPROVAL',
                  proposedPrompt: 'Review bounded visitor reliability evidence.',
                  rationale: 'This is the exact scoped interpretation of the founder direction.',
                  constraints: ['No customer contact.', 'No venue mutation.'],
                  founderOperatingExchange: {
                    prompt: 'Review this venue’s visitor reliability issues.',
                  },
                },
                expired: false,
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    expect(screen.getByText('Founder direction → proposed task')).toBeTruthy()
    expect(screen.getByText(/Review this venue’s visitor reliability issues/)).toBeTruthy()
    expect(screen.getByText(/Review bounded visitor reliability evidence/)).toBeTruthy()
    expect(screen.getByText('No customer contact.')).toBeTruthy()
    expect(screen.getByText(/does not execute the task or widen/)).toBeTruthy()
  })

  it('links attention items to exact tenant and venue evidence without raw details', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          evaluations: {
            items: [
              {
                id: 'eval_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                status: 'RUNNING',
                attemptNumber: 2,
                maxAttempts: 3,
                executionLeaseExpiresAt: new Date(),
                lastErrorCode: null,
                createdAt: new Date(),
                expiredLease: true,
              },
            ],
            nextCursor: null,
          },
          support: {
            items: [
              {
                id: 'request_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                category: 'CONTENT_CORRECTION',
                status: 'VALIDATING',
                subject: 'Hours review',
                version: 2,
                onboardingQuestionLink: { id: 'link_1', agentQuestionId: 'question_1' },
                updatedAt: new Date(),
                createdAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )
    expect(
      screen.getByRole('link', { name: 'Open evaluation evidence' }).getAttribute('href'),
    ).toBe('/admin/clients/tenant_1/venues/venue_1/evaluations')
    expect(screen.getByRole('link', { name: 'Open scoped request' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/support-operations?requestId=request_1',
    )
    expect(screen.getByText('Onboarding blocker')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open blocked work' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/agents#inbox',
    )
    expect(screen.getByText('Lease expired')).toBeTruthy()
    expect(screen.queryByText('secret provider payload')).toBeNull()
  })

  it('routes knowledge proposal events to the review workspace', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          events: {
            items: [
              {
                id: 'event_1',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'knowledge.proposal.created',
                sourceSubsystem: 'knowledge',
                severity: 'WARNING',
                title: 'Knowledge update proposed',
                summary: 'A grounded update is ready for review.',
                recommendedAction: 'Review the evidence.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'KnowledgeChangeProposal',
                linkedObjectId: 'proposal_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/venues/venue_1/knowledge-proposals',
    )
  })

  it('routes AI cost events to the tenant budget controls instead of chat logs', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          events: {
            items: [
              {
                id: 'event_cost',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'ai-cost-budget.breached',
                sourceSubsystem: 'ai-cost-control',
                severity: 'ERROR',
                title: 'AI cost budget stopped new requests',
                summary: 'The configured budget is breached.',
                recommendedAction: 'Review usage and reservations.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'AiCostBudget',
                linkedObjectId: 'budget_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1#ai-cost-budget',
    )
  })

  it('routes first-week learning drafts to the aggregate review evidence', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          events: {
            items: [
              {
                id: 'event_first_week',
                tenantId: 'tenant_1',
                venueId: 'venue_1',
                eventType: 'customer-learning.first-week-draft-ready',
                sourceSubsystem: 'first-week-account-review',
                severity: 'INFO',
                title: 'day 3 customer check-in draft',
                summary: 'A privacy-bounded first-week review produced a draft for human review.',
                recommendedAction: 'Review the aggregate evidence and edit or discard the draft.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'FirstWeekAccountReview',
                linkedObjectId: 'review_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/clients/tenant_1/analytics#first-week-reviews',
    )
  })

  it('renders platform CRM attention without a fabricated tenant link', () => {
    render(
      <OperationsAttentionConsole
        data={{
          ...empty,
          platformEvents: {
            items: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                eventType: 'crm.import.completed_with_issues',
                sourceSubsystem: 'prospect-crm',
                severity: 'WARNING',
                title: 'Prospect import completed with issues',
                summary: 'Review quarantined rows.',
                recommendedAction: 'Review the bounded report.',
                state: 'OPEN',
                actionRequired: true,
                linkedObjectType: 'ProspectImport',
                linkedObjectId: 'import_1',
                occurrenceCount: 1,
                createdAt: new Date(),
                lastOccurredAt: new Date(),
              },
            ],
            nextCursor: null,
          },
        }}
      />,
    )

    expect(screen.getByText('Prospect import completed with issues')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Open related workspace' }).getAttribute('href')).toBe(
      '/admin/prospects/imports',
    )
  })
})
