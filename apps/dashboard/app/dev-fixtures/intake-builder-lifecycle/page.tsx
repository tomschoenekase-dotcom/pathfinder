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
  fileUpload: null,
  fileExtraction: null,
  fileExtractionReview: null,
  fileClarificationReview: null,
  websiteClarificationReview: {
    receiptId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
    researchHash: 'a'.repeat(64),
    answersGrantAuthority: false,
    eligibleIdentities: [{ id: 'fixture-content', name: 'Content reviewer' }],
    mappingOptions: [
      {
        evidenceId: 'fixture-evidence-a',
        fieldPath: 'venue.name',
        value: 'Torchiko Hall',
        sourceUrl: 'https://example.org/',
        locator: 'title',
        confidence: 0.92,
      },
      {
        evidenceId: 'fixture-evidence-b',
        fieldPath: 'venue.name',
        value: 'Torchiko Ballroom',
        sourceUrl: 'https://example.org/about',
        locator: 'meta[property="og:title"]',
        confidence: 0.76,
      },
      {
        evidenceId: 'fixture-phone',
        fieldPath: 'venue.phone',
        value: '312-555-0100',
        sourceUrl: 'https://example.org/contact',
        locator: 'json-ld',
        confidence: 0.9,
      },
    ],
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
  interviewClarificationReview: null,
  currentStage: 'CONSTRUCT',
  currentState: 'BLOCKED',
  nextAction: 'CREATE_PACKAGE_DRAFT',
  requiresHumanApproval: false,
  autoApprove: false,
  autoApply: false,
  autoPublish: false,
  stages: stages.map((stage, index) => ({
    stage,
    state:
      index < 5
        ? ('COMPLETE' as const)
        : stage === 'CONSTRUCT'
          ? ('BLOCKED' as const)
          : ('PENDING' as const),
    evidenceRefs: index < 5 ? ['intake-run:fixture-run'] : [],
    blockers:
      stage === 'CONSTRUCT'
        ? [
            {
              code: 'WEBSITE_MAPPING_REVIEW_REQUIRED',
              path: 'websiteResearch',
              message: 'Review cited website claims before creating a package DRAFT.',
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
          mappingSelections={{ 'venue.phone': 'fixture-phone' }}
          onMappingSelectionChange={() => undefined}
          onPreviewWebsiteMapping={() => undefined}
        />
      </div>
    </main>
  )
}
