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
  runId: 'fixture-interview-run',
  sourceKind: 'INTERVIEW',
  runStatus: 'AWAITING_REVIEW',
  websiteResearch: null,
  fileUpload: null,
  fileExtraction: null,
  fileExtractionReview: null,
  fileClarificationReview: null,
  websiteClarificationReview: null,
  interviewClarificationReview: {
    reviewHash: 'a'.repeat(64),
    answersGrantAuthority: false,
    sourceAmendmentRequired: true,
    eligibleIdentities: [{ id: 'fixture-content', name: 'Content reviewer' }],
    clarifications: [
      {
        clarificationId: 'interview-clarification-hours',
        questionId: 'operations.hours',
        fieldPath: 'venue.operations.hours',
        reasons: ['LOW_CONFIDENCE'],
        evidence: [
          {
            label: 'What are the public operating hours?',
            reference: 'intake-evidence:fixture-hours',
            summary: 'Open nine to five, except event nights · 55% confidence',
          },
        ],
        proposedAnswer: {
          value: 'Open nine to five, except event nights.',
          evidenceId: 'fixture-hours',
          confidence: 0.55,
          status: 'PROPOSED_ONLY',
        },
        question: null,
      },
      {
        clarificationId: 'interview-clarification-closures',
        questionId: 'operations.closures',
        fieldPath: 'venue.operations.closures',
        reasons: ['MISSING_CONTEXT'],
        evidence: [
          {
            label: 'When is the venue closed?',
            reference: 'intake-run:fixture-interview-run:question:operations.closures',
            summary: 'No public answer text retained · missing context',
          },
        ],
        proposedAnswer: null,
        question: {
          id: 'fixture-question-closures',
          status: 'ANSWERED',
          answer: 'Closed on New Year’s Day and Thanksgiving.',
          agentIdentityId: 'fixture-content',
          updatedAt: new Date('2026-08-28T23:00:00.000Z'),
          answerGuidanceOnly: true,
        },
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
      index < 5
        ? ('COMPLETE' as const)
        : stage === 'RECONCILE' || stage === 'CLARIFY'
          ? ('BLOCKED' as const)
          : ('PENDING' as const),
    evidenceRefs: index < 5 ? ['intake-run:fixture-interview-run'] : [],
    blockers:
      stage === 'RECONCILE' || stage === 'CLARIFY'
        ? [
            {
              code: 'INTERVIEW_DISCREPANCY',
              path: 'venue.operations',
              message: 'Resolve retained staff-answer discrepancies before creating a package.',
            },
          ]
        : [],
  })),
}

export default function IntakeBuilderInterviewClarificationFixture() {
  return (
    <main
      data-fixture="intake-builder-interview-clarification"
      className="min-h-screen bg-pf-surface p-4 sm:p-8"
    >
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <p className="text-sm font-medium text-pf-deep">Staff interview · awaiting review</p>
        <p className="mt-1 text-sm text-pf-deep/70">
          Two retained discrepancies · no package draft
        </p>
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
