import type { inferRouterOutputs } from '@trpc/server'

import type { AppRouter } from '@pathfinder/api'
import { OperationsAttentionConsole } from '../../../components/admin/OperationsAttentionConsole'
import { TRPCProvider } from '../../../lib/trpc'

type Data = inferRouterOutputs<AppRouter>['admin']['attentionConsole']

const emptyPage = { items: [], nextCursor: null }
const data: Data = {
  generatedAt: new Date('2026-08-22T20:00:00.000Z'),
  jobs: emptyPage,
  evaluations: emptyPage,
  approvals: emptyPage,
  support: emptyPage,
  agents: emptyPage,
  questions: emptyPage,
  workingAgents: emptyPage,
  blockedAgents: emptyPage,
  completedAgents: emptyPage,
  outcomes: emptyPage,
  events: emptyPage,
  platformEvents: emptyPage,
  founderConversation: [],
  workers: [],
  unitEconomics: {
    schemaVersion: 'founder-unit-economics.v1',
    generatedAt: new Date('2026-08-22T20:00:00.000Z'),
    window: {
      days: 30,
      start: new Date('2026-07-23T20:00:00.000Z'),
      endExclusive: new Date('2026-08-22T20:00:00.000Z'),
      previousStart: new Date('2026-06-23T20:00:00.000Z'),
    },
    totals: {
      knownOperatingCostUsd: '148.50000000',
      priorKnownOperatingCostUsd: '121.25000000',
      changeUsd: '27.25000000',
      changePercent: 22.47,
    },
    ai: {
      estimatedCostUsd: '86.50000000',
      requestCount: 1240,
      attributedTenantCount: 5,
      completeness: 'PROVIDER_PRICING_ESTIMATE',
    },
    nonAi: {
      evidencedCostUsd: '62.00000000',
      platformUnallocatedUsd: '40.00000000',
      tenantOrVenueAttributedUsd: '22.00000000',
      evidenceCount: 3,
      excludedOverlappingEvidenceCount: 1,
      categories: [
        {
          category: 'INFRASTRUCTURE',
          represented: true,
          amountUsd: '40.00000000',
          entryCount: 1,
          evidenceKinds: ['OBSERVED'],
        },
        {
          category: 'STORAGE',
          represented: true,
          amountUsd: '22.00000000',
          entryCount: 2,
          evidenceKinds: ['ALLOCATED'],
        },
      ],
    },
    operationalUsage: {
      interpretation: 'Latest measured quantities are not provider invoices or dollar costs.',
      rowsReturned: 5,
      truncated: false,
      freshness: { declaredUsageDays: 2, queueUsageMinutes: 60 },
      metrics: [
        {
          metric: 'INTAKE_DECLARED_BYTES',
          represented: true,
          quantity: '8388608',
          unit: 'BYTES',
          scopeCount: 3,
          latestObservedAt: new Date('2026-08-22T00:00:00.000Z'),
          sourceSystems: ['torchiko-database-declared-usage'],
        },
        {
          metric: 'MEDIA_DECLARED_BYTES',
          represented: true,
          quantity: '536870912',
          unit: 'BYTES',
          scopeCount: 2,
          latestObservedAt: new Date('2026-08-22T00:00:00.000Z'),
          sourceSystems: ['torchiko-database-declared-usage'],
        },
        {
          metric: 'QUEUE_DEPTH',
          represented: true,
          quantity: '4',
          unit: 'JOBS',
          scopeCount: 1,
          latestObservedAt: new Date('2026-08-22T19:55:00.000Z'),
          sourceSystems: ['bullmq-operational-snapshot'],
        },
        {
          metric: 'QUEUE_FAILED_JOBS',
          represented: true,
          quantity: '1',
          unit: 'JOBS',
          scopeCount: 1,
          latestObservedAt: new Date('2026-08-22T19:55:00.000Z'),
          sourceSystems: ['bullmq-operational-snapshot'],
        },
        {
          metric: 'QUEUE_OLDEST_AGE_MILLISECONDS',
          represented: true,
          quantity: '42000',
          unit: 'MILLISECONDS',
          scopeCount: 1,
          latestObservedAt: new Date('2026-08-22T19:55:00.000Z'),
          sourceSystems: ['bullmq-operational-snapshot'],
        },
      ],
      representedMetrics: [
        'INTAKE_DECLARED_BYTES',
        'MEDIA_DECLARED_BYTES',
        'QUEUE_DEPTH',
        'QUEUE_FAILED_JOBS',
        'QUEUE_OLDEST_AGE_MILLISECONDS',
      ],
      unrepresentedMetrics: [],
      assignsDollarValue: false,
      definesAnomalyThreshold: false,
    },
    coverage: {
      representedCategories: ['INFRASTRUCTURE', 'STORAGE'],
      unrepresentedCategories: [
        'EMAIL',
        'MEDIA_PROCESSING',
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
    state: 'NEGATIVE_EVIDENCE_PRESENT',
    verdicts: { positive: 8, mixed: 2, negative: 1, inconclusive: 1 },
    observations: 12,
    distinctObservedRuns: 10,
    completedRuns: { visible: 12, withObservation: 10, withoutObservation: 2 },
    runs: { visible: 12, completed: 10, failed: 2 },
    actions: { visible: 18, succeeded: 14, failed: 2, denied: 2, cancelled: 0 },
    approvalDecisions: {
      visible: 5,
      approved: 4,
      rejected: 1,
      cancelled: 0,
      expired: 0,
      acceptance: { numerator: 4, denominator: 5, rate: 0.8, excludes: ['CANCELLED', 'EXPIRED'] },
    },
    qualityEvaluations: { positive: 5, mixed: 1, negative: 1, inconclusive: 0 },
    customerSignals: { positive: 2, mixed: 1, negative: 0, inconclusive: 0 },
    rollbackEvidence: {
      observations: 2,
      distinctActions: 2,
      succeededActionDenominator: 14,
      rate: null,
      completeWindow: false,
    },
    policyViolationEvidence: {
      observations: 1,
      low: 0,
      medium: 0,
      high: 1,
      critical: 0,
      policyCodes: ['customer-contact-without-approval'],
    },
    confidenceCalibration: {
      observations: 6,
      correct: 4,
      incorrect: 2,
      meanPredictedConfidence: 0.78,
      observedAccuracy: 2 / 3,
      brierScore: 0.19,
      completeWindow: false,
    },
    taskClasses: ['onboarding', 'support'],
    signalKinds: ['HUMAN_REVIEW', 'QUALITY_EVALUATION'],
    byAgent: [
      {
        agentIdentityId: 'agent_1',
        name: 'Support operator',
        runs: { visible: 12, completed: 10, failed: 2 },
        actions: { visible: 18, succeeded: 14, failed: 2, denied: 2 },
        outcomes: { positive: 8, mixed: 2, negative: 1, inconclusive: 1 },
        operationalTrust: { rollbacks: 2, policyViolations: 1, confidencePairs: 6 },
        approvals: { decided: 5, approved: 4, rejected: 1 },
        taskClasses: ['onboarding', 'support'],
      },
    ],
    evidenceCoverage: {
      executionRuns: 'AVAILABLE',
      explicitOutcomes: 'AVAILABLE',
      toolActions: 'AVAILABLE',
      approvalAcceptance: 'AVAILABLE',
      deniedActions: 'AVAILABLE_NOT_POLICY_VIOLATION',
      rollbackRate: 'AVAILABLE_BOUNDED_WINDOW',
      policyViolations: 'AVAILABLE_CANONICAL_SIGNAL',
      confidenceCalibration: 'AVAILABLE_CANONICAL_PREDICTION_OUTCOME_PAIR',
    },
    boundedSnapshot: { hasMore: true },
    policy: {
      approvalReductionRecommended: false,
      explanation:
        'Negative evidence is present. Inspect the underlying runs and corrections; this snapshot does not support reducing approval.',
    },
  },
  founderAbsenceReadiness: {
    schemaVersion: 2,
    generatedAt: new Date('2026-08-22T20:00:00.000Z'),
    kind: 'READINESS_SNAPSHOT',
    target: {
      ordinaryOperationDays: 7,
      launchGate: false,
      certification: 'NOT_CERTIFIED',
      observationState: 'NOT_STARTED',
      observedDays: 0,
      explanation:
        'A representative uninterrupted week has not been recorded. This current-state snapshot prepares the maturity test; it does not certify it.',
    },
    observationHistory: {
      retainedDays: 0,
      consecutiveDays: 0,
      latestObservedOn: null,
      latestCapturedAt: null,
      latestReleaseSha: null,
      currentReleaseSha: null,
      latestReleaseMatchesCurrent: false,
      stale: false,
      incompleteSamples: 0,
      immutableDailySamples: true,
    },
    summary: { dimensionsWithReviewCandidates: 4, visibleSignals: 9 },
    dimensions: [
      {
        key: 'FOUNDER_WAITS',
        label: 'Founder waits',
        visibleSignals: 2,
        hasMore: false,
        state: 'REVIEW_CANDIDATES',
        interpretation:
          'Blocking questions, undecided approvals, and waiting runs are review candidates; this view cannot decide which waits are unnecessary.',
      },
      {
        key: 'PERMISSION_FRICTION',
        label: 'Permission friction',
        visibleSignals: 2,
        hasMore: true,
        state: 'REVIEW_CANDIDATES',
        interpretation:
          'Approval-waiting runs and denied actions may show narrow permissions, but denial is not treated as a policy defect.',
      },
      {
        key: 'REPEATED_ESCALATIONS',
        label: 'Repeated escalations',
        visibleSignals: 0,
        hasMore: false,
        state: 'NO_VISIBLE_SIGNAL',
        interpretation:
          'Counts open event groups with more than one recorded occurrence; no escalation-storm threshold has been invented.',
      },
      {
        key: 'CUSTOMER_RESPONSE_WORK',
        label: 'Customer response work',
        visibleSignals: 1,
        hasMore: false,
        state: 'REVIEW_CANDIDATES',
        interpretation:
          'Active support work not waiting on the client is visible here; without a settled SLA, this is not labeled late or missed.',
      },
      {
        key: 'FAILED_AUTOMATION',
        label: 'Failed automation',
        visibleSignals: 0,
        hasMore: false,
        state: 'NO_VISIBLE_SIGNAL',
        interpretation: 'Visible failures are counted as signals, not deduplicated incidents.',
      },
      {
        key: 'HIDDEN_MANUAL_STEPS',
        label: 'Hidden manual steps',
        visibleSignals: 0,
        hasMore: false,
        state: 'NO_VISIBLE_SIGNAL',
        interpretation:
          'An input-waiting run without a visible linked blocking question is a coordination gap candidate, not proof of hidden work.',
      },
      {
        key: 'UNCONTROLLED_EFFECTS',
        label: 'Uncontrolled effects',
        visibleSignals: 4,
        hasMore: true,
        state: 'REVIEW_CANDIDATES',
        interpretation:
          'Canonical rollback, policy-violation, and negative customer signals are counted; denied actions are intentionally excluded.',
      },
    ],
    evidenceWindow: {
      kind: 'BOUNDED_CURRENT_STATE',
      complete: false,
      hasMore: true,
      historicalContinuityVerified: false,
    },
    authority: {
      effect: 'READ_ONLY',
      canChangePermissions: false,
      canResolveWork: false,
      canCertifyMaturity: false,
    },
  },
  briefing: {
    schemaVersion: 2,
    focus: {
      kind: 'CLEAR',
      urgency: 'NONE',
      label: 'No urgent founder action',
      title: 'The operating queues are clear.',
      detail:
        'No critical risk, blocking question, pending approval, action-required event, blocked run, or support item is visible in this bounded snapshot.',
      action: { label: 'See what agents are doing', href: '#ai-workforce' },
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
    boundedSnapshot: { limit: 12, hasMore: true },
    reviewState: {
      lastReviewedThrough: new Date('2026-08-22T19:00:00.000Z'),
      changesSinceLastReview: {
        criticalRisks: 0,
        decisions: 0,
        completedAgents: 2,
        outcomes: 3,
        customerItems: 0,
        attentionItems: 0,
      },
      changeDigest: { limit: 5, visibleCount: 0, mayHaveMore: false, items: [] },
      hasUnreviewedChanges: true,
    },
  },
}

export default async function AgentTrustEvidenceFixturePage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>
}) {
  const { focus } = await searchParams
  const fixtureData =
    focus === 'decision'
      ? {
          ...data,
          briefing: {
            ...data.briefing,
            focus: {
              kind: 'CUSTOMER_RISK' as const,
              urgency: 'CRITICAL' as const,
              label: 'Customer or system risk',
              title: 'Visitor chat is unavailable',
              detail: 'Inspect the affected visitor turns and provider evidence.',
              action: { label: 'Review risk now', href: '#alerts' },
              source: {
                scope: 'TENANT' as const,
                objectType: 'operational-event',
                objectId: 'event_fixture',
                tenantId: 'tenant_fixture',
                venueId: 'venue_fixture',
              },
              decisionContext: {
                attentionReason:
                  'An open action-required event is recorded at critical or error severity.',
                consequence: 'The recorded risk remains unresolved until it is reviewed.',
                observedAt: new Date('2026-08-22T19:42:00.000Z'),
                deadline: null,
                occurrenceCount: 3,
                founderResponseRequiredToProceed: false,
              },
            },
            metrics: { ...data.briefing.metrics, criticalRisks: 1, actionItems: 1 },
          },
        }
      : data
  return (
    <TRPCProvider scopeKey="agent-trust-evidence-fixture">
      <main data-fixture="agent-trust-evidence" className="min-h-screen bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto max-w-7xl">
          <OperationsAttentionConsole data={fixtureData} />
        </div>
      </main>
    </TRPCProvider>
  )
}
