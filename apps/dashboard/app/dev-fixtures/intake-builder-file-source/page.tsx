'use client'

import {
  IntakeBuilderLifecycleView,
  type IntakeBuilderLifecycle,
} from '../../../components/admin/IntakeBuilderLifecyclePanel'
import {
  OnboardingBootstrapReview,
  type OnboardingBootstrapCandidate,
} from '../../../components/admin/OnboardingBootstrapReview'
import { TRPCProvider } from '../../../lib/trpc'

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

const sha256 = 'c'.repeat(64)
const lifecycle: IntakeBuilderLifecycle = {
  schemaVersion: 1,
  runId: 'fixture-file-run',
  sourceKind: 'FILE_UPLOAD',
  runStatus: 'AWAITING_REVIEW',
  websiteResearch: null,
  fileUpload: {
    uploadId: 'fixture-upload',
    displayName: 'Visitor services handbook — summer operating guide',
    fileName: 'visitor-services-handbook-summer-2026-reviewed-source.md',
    mimeType: 'text/markdown',
    category: 'DOCUMENT',
    byteSize: 2_438_619,
    sha256,
    verifiedAt: new Date('2026-08-29T02:00:00.000Z'),
    deterministicTextExtractionAvailable: true,
  },
  fileExtraction: null,
  fileExtractionReview: null,
  fileClarificationReview: null,
  websiteClarificationReview: null,
  interviewClarificationReview: null,
  currentStage: 'EXTRACT',
  currentState: 'BLOCKED',
  nextAction: 'RUN_FILE_EXTRACTION',
  requiresHumanApproval: false,
  autoApprove: false,
  autoApply: false,
  autoPublish: false,
  stages: stages.map((stage) => ({
    stage,
    state:
      stage === 'INGEST' || stage === 'NORMALIZE' || stage === 'ANALYZE'
        ? ('COMPLETE' as const)
        : stage === 'RESEARCH'
          ? ('SKIPPED' as const)
          : stage === 'EXTRACT'
            ? ('BLOCKED' as const)
            : ('PENDING' as const),
    evidenceRefs:
      stage === 'INGEST' || stage === 'NORMALIZE' || stage === 'ANALYZE'
        ? ['intake-run:fixture-file-run', 'intake-upload:fixture-upload']
        : stage === 'EXTRACT'
          ? [`intake-upload-sha256:${sha256}`]
          : [],
    blockers:
      stage === 'EXTRACT'
        ? [
            {
              code: 'FILE_EXTRACTION_REQUIRED',
              path: 'fileUpload',
              message:
                'The verified text-like document is ready for one bounded deterministic extraction.',
            },
          ]
        : [],
  })),
}

const extractedLifecycle: IntakeBuilderLifecycle = {
  ...lifecycle,
  fileExtraction: {
    receiptId: '568c2e1a-8ece-47ad-98dc-e4bde64872ca',
    outcome: 'SUCCEEDED',
    extractor: 'pathfinder-utf8-document',
    extractorVersion: '1',
    extractedTextHash: 'd'.repeat(64),
    extractedCharacterCount: 156,
    extractedLineCount: 5,
    errorCode: null,
    errorMessage: null,
    review: null,
  },
  fileExtractionReview: {
    receiptId: '568c2e1a-8ece-47ad-98dc-e4bde64872ca',
    extractor: 'pathfinder-utf8-document',
    extractorVersion: '1',
    extractedTextHash: 'd'.repeat(64),
    extractedCharacterCount: 156,
    extractedLineCount: 5,
    preview:
      '# Visitor services\n\nGeneral admission begins at 9:00 a.m.\nHoliday hours vary and require manager confirmation.\nThis text has not been reviewed.',
    previewTruncated: false,
    createdAt: new Date('2026-08-29T03:30:00.000Z'),
    reviewRequired: true,
    review: null,
    grantsAuthority: false,
  },
  fileClarificationReview: {
    receiptId: '568c2e1a-8ece-47ad-98dc-e4bde64872ca',
    extractedTextHash: 'd'.repeat(64),
    sourceRunId: 'fixture-file-source-run',
    carriedForward: false,
    canCreate: true,
    questions: [
      {
        id: 'fixture-file-question',
        fieldPath: 'venue.operations.holidayHours',
        reason: 'DATE_SENSITIVE',
        blockerScope: 'LOCAL',
        blocksTerminalReview: false,
        question: 'Which holiday-hours schedule should Builder use?',
        status: 'PENDING',
        answer: null,
        evidence: [
          {
            label: 'venue.operations.holidayHours',
            reference: 'intake-file-extraction:568c2e1a-8ece-47ad-98dc-e4bde64872ca',
            summary: 'Holiday hours vary and require manager confirmation.',
          },
        ],
        agentIdentityId: 'fixture-content-identity',
        updatedAt: new Date('2026-08-29T03:35:00.000Z'),
        answerGuidanceOnly: true,
      },
    ],
    eligibleIdentities: [{ id: 'fixture-content-identity', name: 'Builder content' }],
    foundationalPending: 0,
    localPending: 1,
    answersGrantAuthority: false,
    sourceAmendmentRequired: true,
  },
  currentStage: 'CONSTRUCT',
  currentState: 'BLOCKED',
  nextAction: 'REVIEW_FILE_EXTRACTION',
  stages: lifecycle.stages.map((stage) =>
    stage.stage === 'EXTRACT'
      ? {
          ...stage,
          state: 'COMPLETE' as const,
          evidenceRefs: [
            ...stage.evidenceRefs,
            'file-extraction:568c2e1a-8ece-47ad-98dc-e4bde64872ca',
          ],
          blockers: [],
        }
      : stage.stage === 'CONSTRUCT'
        ? {
            ...stage,
            state: 'BLOCKED' as const,
            evidenceRefs: ['file-extraction:568c2e1a-8ece-47ad-98dc-e4bde64872ca'],
            blockers: [
              {
                code: 'FILE_EXTRACTION_REVIEW_REQUIRED',
                path: 'fileExtraction',
                message:
                  'The deterministic extraction is retained for review but cannot become structured venue content without a separate exact review.',
              },
            ],
          }
        : stage,
  ),
}

const reviewedCandidate = {
  runId: 'fixture-file-review-run',
  sourceKind: 'STRUCTURED_BOOTSTRAP',
  status: 'AWAITING_REVIEW',
  ready: true,
  candidateHash: 'a'.repeat(64),
  payload: {
    schemaVersion: 3,
    places: { create: [], update: [], delete: [] },
    knowledgeEntries: { create: [], update: [], delete: [] },
  },
  issues: [],
  summary: { candidateCount: 1, issueCount: 0 },
  autoApprove: false,
  autoApply: false,
  published: false,
} satisfies OnboardingBootstrapCandidate

export default function IntakeBuilderFileSourceFixture() {
  return (
    <main
      data-fixture="intake-builder-file-source"
      className="min-h-screen bg-pf-surface p-4 sm:p-8"
    >
      <title>Torchiko Builder file extraction fixture</title>
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <h1 className="text-sm font-medium text-pf-deep">Document upload · verified source</h1>
        <h2 className="sr-only">Verified source lifecycle</h2>
        <p className="mt-1 text-sm text-pf-deep/70">
          Immutable evidence retained · extraction review still required
        </p>
        <IntakeBuilderLifecycleView
          lifecycle={lifecycle}
          ariaLabel="Builder lifecycle ready for extraction"
          onRunFileExtraction={() => undefined}
        />
        <div className="mt-8 border-t border-pf-light pt-6">
          <h2 className="text-sm font-medium text-pf-deep">
            Document extraction · retained preview
          </h2>
          <p className="mt-1 text-sm text-pf-deep/70">
            Deterministic text remains private and unreviewed
          </p>
          <IntakeBuilderLifecycleView
            lifecycle={extractedLifecycle}
            ariaLabel="Builder lifecycle extracted text review"
            extractionReviewDecision="ACCEPTED_FOR_PROPOSAL"
            extractionProposalTitle="Reviewed visitor services notes"
            extractionProposalNotes="General admission begins at 9:00 a.m. The unresolved holiday-hours claim is excluded pending clarification."
            extractionReviewRationale="The retained text is legible and the exact proposal notes exclude the unresolved holiday-hours claim."
            onExtractionReviewDecisionChange={() => undefined}
            onExtractionProposalTitleChange={() => undefined}
            onExtractionProposalNotesChange={() => undefined}
            onExtractionReviewRationaleChange={() => undefined}
            onReviewFileExtraction={() => undefined}
            clarificationIdentityId="fixture-content-identity"
            onClarificationIdentityChange={() => undefined}
            fileClarificationFieldPath="venue.operations.holidayHours"
            fileClarificationReason="DATE_SENSITIVE"
            fileClarificationBlockerScope="LOCAL"
            fileClarificationExcerpt="Holiday hours vary and require manager confirmation."
            fileClarificationQuestion="Which holiday-hours schedule should Builder use?"
            onFileClarificationFieldPathChange={() => undefined}
            onFileClarificationReasonChange={() => undefined}
            onFileClarificationBlockerScopeChange={() => undefined}
            onFileClarificationExcerptChange={() => undefined}
            onFileClarificationQuestionChange={() => undefined}
            onCreateFileClarificationQuestion={() => undefined}
          />
        </div>
        <div className="mt-8 border-t border-pf-light pt-6">
          <h2 className="text-sm font-medium text-pf-deep">
            Accepted extraction review · package candidate
          </h2>
          <p className="mt-1 text-sm text-pf-deep/70">
            Human-reviewed notes remain a proposal until a separate DRAFT review
          </p>
          <div className="mt-4">
            <TRPCProvider scopeKey="fixture:file-extraction-package-candidate">
              <OnboardingBootstrapReview
                tenantId="fixture-tenant"
                venueId="fixture-venue"
                run={{
                  id: 'fixture-file-review-run',
                  displayName: 'Reviewed visitor information',
                  status: 'AWAITING_REVIEW',
                  structuredBootstrap: {
                    kind: 'FILE_EXTRACTION_REVIEW',
                    sourceRunId: 'fixture-file-run',
                    receiptId: '568c2e1a-8ece-47ad-98dc-e4bde64872ca',
                    sourceSha256: sha256,
                    extractedTextHash: 'd'.repeat(64),
                    reviewRationale:
                      'The retained text is legible and unresolved claims were excluded.',
                  },
                }}
                fixtureCandidate={reviewedCandidate}
              />
            </TRPCProvider>
          </div>
        </div>
      </div>
    </main>
  )
}
