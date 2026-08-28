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
  briefing: {
    schemaVersion: 1,
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

export default function AgentTrustEvidenceFixturePage() {
  return (
    <TRPCProvider scopeKey="agent-trust-evidence-fixture">
      <main data-fixture="agent-trust-evidence" className="min-h-screen bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto max-w-7xl">
          <OperationsAttentionConsole data={data} />
        </div>
      </main>
    </TRPCProvider>
  )
}
