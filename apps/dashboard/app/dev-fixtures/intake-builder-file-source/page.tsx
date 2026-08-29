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
    grantsAuthority: false,
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

export default function IntakeBuilderFileSourceFixture() {
  return (
    <main
      data-fixture="intake-builder-file-source"
      className="min-h-screen bg-pf-surface p-4 sm:p-8"
    >
      <div className="mx-auto max-w-5xl rounded-2xl border border-pf-light bg-white p-4 sm:p-6">
        <p className="text-sm font-medium text-pf-deep">Document upload · verified source</p>
        <p className="mt-1 text-sm text-pf-deep/70">
          Immutable evidence retained · extraction review still required
        </p>
        <IntakeBuilderLifecycleView
          lifecycle={lifecycle}
          ariaLabel="Builder lifecycle ready for extraction"
          onRunFileExtraction={() => undefined}
        />
        <div className="mt-8 border-t border-pf-light pt-6">
          <p className="text-sm font-medium text-pf-deep">Document extraction · retained preview</p>
          <p className="mt-1 text-sm text-pf-deep/70">
            Deterministic text remains private and unreviewed
          </p>
          <IntakeBuilderLifecycleView
            lifecycle={extractedLifecycle}
            ariaLabel="Builder lifecycle extracted text review"
          />
        </div>
      </div>
    </main>
  )
}
