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
  workers: [],
  agentTrustEvidence: {
    schemaVersion: 1,
    state: 'NEGATIVE_EVIDENCE_PRESENT',
    verdicts: { positive: 8, mixed: 2, negative: 1, inconclusive: 1 },
    observations: 12,
    distinctObservedRuns: 10,
    completedRuns: { visible: 12, withObservation: 10, withoutObservation: 2 },
    taskClasses: ['onboarding', 'support'],
    signalKinds: ['HUMAN_REVIEW', 'QUALITY_EVALUATION'],
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
        'No critical risk, blocking question, pending approval, blocked run, or support item is visible in this bounded snapshot.',
      action: { label: 'See what agents are doing', href: '#ai-workforce' },
      source: {
        scope: 'PLATFORM',
        objectType: 'attention-console',
        objectId: null,
        tenantId: null,
        venueId: null,
      },
    },
    metrics: { decisions: 0, criticalRisks: 0, workingAgents: 0, customerItems: 0 },
    boundedSnapshot: { limit: 12, hasMore: true },
    reviewState: {
      lastReviewedThrough: new Date('2026-08-22T19:00:00.000Z'),
      changesSinceLastReview: {
        criticalRisks: 0,
        decisions: 0,
        completedAgents: 2,
        outcomes: 3,
        customerItems: 0,
      },
      changeDigest: { limit: 5, visibleCount: 0, mayHaveMore: false, items: [] },
      hasUnreviewedChanges: true,
    },
  },
}

export default function AgentTrustEvidenceFixturePage() {
  return (
    <TRPCProvider scopeKey="agent-trust-evidence-fixture">
      <main className="min-h-screen bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto max-w-7xl">
          <OperationsAttentionConsole data={data} />
        </div>
      </main>
    </TRPCProvider>
  )
}
