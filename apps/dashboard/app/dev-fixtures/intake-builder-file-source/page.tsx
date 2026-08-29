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
    fileName: 'visitor-services-handbook-summer-2026-reviewed-source.pdf',
    mimeType: 'application/pdf',
    category: 'DOCUMENT',
    byteSize: 2_438_619,
    sha256,
    verifiedAt: new Date('2026-08-29T02:00:00.000Z'),
  },
  websiteClarificationReview: null,
  interviewClarificationReview: null,
  currentStage: 'EXTRACT',
  currentState: 'BLOCKED',
  nextAction: 'REVIEW_FILE_SOURCE',
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
              code: 'FILE_EXTRACTION_REVIEW_REQUIRED',
              path: 'fileUpload',
              message:
                'The verified file is retained, but no reviewed extraction is available for a package candidate.',
            },
          ]
        : [],
  })),
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
        <IntakeBuilderLifecycleView lifecycle={lifecycle} />
      </div>
    </main>
  )
}
