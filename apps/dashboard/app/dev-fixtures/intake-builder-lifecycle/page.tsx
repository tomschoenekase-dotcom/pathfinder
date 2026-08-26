'use client'

import {
  IntakeBuilderLifecycleView,
  type IntakeBuilderLifecycle,
} from '../../../components/admin/IntakeBuilderLifecyclePanel'

const stages = [
  'INGEST',
  'NORMALIZE',
  'ANALYZE',
  'RESEARCH',
  'EXTRACT',
  'CONSTRUCT',
  'RECONCILE',
  'CLARIFY',
  'VALIDATE',
  'SIMULATE',
  'QA',
  'REVIEW',
  'READY',
  'PUBLISH',
] as const

const lifecycle: IntakeBuilderLifecycle = {
  schemaVersion: 1,
  runId: 'fixture-run',
  sourceKind: 'WEBSITE',
  runStatus: 'AWAITING_REVIEW',
  websiteResearch: {
    receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
    outcome: 'SUCCEEDED',
    attemptCount: 1,
    canRetry: false,
    attemptedFetches: 2,
    fetchedPages: 2,
    fetchedBytes: 18_420,
    estimatedCostUnits: 3,
    latencyMs: 1240,
    errorCode: null,
    errorMessage: null,
  },
  websiteClarificationReview: {
    receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
    researchHash: 'a'.repeat(64),
    answersGrantAuthority: false,
    eligibleIdentities: [{ id: 'fixture-content', name: 'Content reviewer' }],
    clarifications: [
      {
        discrepancyId: 'fixture-discrepancy',
        fieldPath: 'venue.name',
        reason: 'CONTRADICTION',
        evidence: [
          {
            label: 'venue.name (92% confidence)',
            reference: 'https://example.org/',
            summary: 'Torchiko Hall · title',
          },
          {
            label: 'venue.name (76% confidence)',
            reference: 'https://example.org/about',
            summary: 'Torchiko Ballroom · meta[property="og:title"]',
          },
        ],
        proposedAnswer: {
          value: 'Torchiko Hall',
          evidenceId: 'fixture-evidence-a',
          confidence: 0.92,
          status: 'PROPOSED_ONLY',
        },
        question: null,
      },
    ],
  },
  currentStage: 'RECONCILE',
  currentState: 'BLOCKED',
  nextAction: 'RESOLVE_CLARIFICATION',
  requiresHumanApproval: false,
  autoApprove: false,
  autoApply: false,
  autoPublish: false,
  stages: stages.map((stage, index) => ({
    stage,
    state:
      index < 6
        ? ('COMPLETE' as const)
        : stage === 'RECONCILE'
          ? ('BLOCKED' as const)
          : ('PENDING' as const),
    evidenceRefs: index < 6 ? ['intake-run:fixture-run'] : [],
    blockers:
      stage === 'RECONCILE'
        ? [
            {
              code: 'WEBSITE_CONTRADICTION',
              path: 'venue.name',
              message: 'Founder/admin clarification is required for venue.name.',
            },
          ]
        : [],
  })),
}

export default function IntakeBuilderLifecycleFixture() {
  return (
    <main className="min-h-screen bg-pf-surface p-4 sm:p-8">
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <p className="text-sm font-medium text-pf-deep">Website proposal · awaiting review</p>
        <p className="mt-1 text-sm text-pf-deep/70">1 evidence record · no package draft</p>
        <IntakeBuilderLifecycleView
          lifecycle={lifecycle}
          clarificationIdentityId="fixture-content"
          onClarificationIdentityChange={() => undefined}
          onCreateClarificationQuestions={() => undefined}
        />
      </div>
    </main>
  )
}
