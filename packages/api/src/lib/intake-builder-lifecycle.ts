export const INTAKE_BUILDER_STAGES = [
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

export type IntakeBuilderStage = (typeof INTAKE_BUILDER_STAGES)[number]
export type IntakeBuilderStageState = 'COMPLETE' | 'CURRENT' | 'BLOCKED' | 'PENDING' | 'SKIPPED'

export type IntakeBuilderBlocker = {
  code: string
  path: string
  message: string
}

export type IntakeBuilderLifecycleInput = {
  runId: string
  sourceKind: string
  runStatus: string
  evidenceCount: number
  websiteResearch: null | {
    receiptId: string
    outcome: 'SUCCEEDED' | 'INACCESSIBLE' | 'FAILED'
    attemptCount: number
    canRetry: boolean
    attemptedFetches: number
    fetchedPages: number
    fetchedBytes: number
    estimatedCostUnits: number
    latencyMs: number
    errorCode: string | null
    errorMessage: string | null
  }
  fileUpload?: null | {
    uploadId: string
    displayName: string
    fileName: string
    mimeType: string
    category: string
    byteSize: number
    sha256: string
    verifiedAt: Date
    deterministicTextExtractionAvailable: boolean
  }
  fileExtraction?: null | {
    receiptId: string
    outcome: 'SUCCEEDED' | 'FAILED'
    extractor: string
    extractorVersion: string
    extractedTextHash: string | null
    extractedCharacterCount: number
    extractedLineCount: number
    errorCode: string | null
    errorMessage: string | null
    review: null | {
      reviewId: string
      decision: 'ACCEPTED_FOR_PROPOSAL' | 'REJECTED'
      proposalRunId: string | null
      proposalNotesHash: string | null
    }
  }
  candidate: null | {
    ready: boolean
    candidateHash: string | null
    candidateCount: number
    issues: readonly IntakeBuilderBlocker[]
  }
  packageDraft: null | {
    id: string
    status: 'DRAFT' | 'APPROVED' | 'APPLIED' | 'REVERTED'
    validationEvidence: 'VALID' | 'INVALID'
    simulationEvidence: 'VALID' | 'INVALID'
    semanticQa: 'RUNNING' | 'COMPLETE' | 'FAILED' | 'STALE' | 'MISSING'
  }
}

export type IntakeBuilderNextAction =
  | 'RUN_WEBSITE_RESEARCH'
  | 'RETRY_WEBSITE_RESEARCH'
  | 'REVIEW_WEBSITE_SOURCE'
  | 'REVIEW_FILE_SOURCE'
  | 'RUN_FILE_EXTRACTION'
  | 'REVIEW_FILE_EXTRACTION'
  | 'REVIEW_STRUCTURED_PROPOSAL'
  | 'RESOLVE_CLARIFICATION'
  | 'CREATE_PACKAGE_DRAFT'
  | 'REPAIR_PACKAGE_EVIDENCE'
  | 'WAIT_FOR_SEMANTIC_QA'
  | 'RETRY_SEMANTIC_QA'
  | 'REVIEW_PACKAGE'
  | 'APPROVE_PACKAGE'
  | 'APPLY_PACKAGE'
  | 'REVIEW_REVERTED_PACKAGE'
  | 'NONE'

export type IntakeBuilderLifecycleStage = {
  stage: IntakeBuilderStage
  state: IntakeBuilderStageState
  evidenceRefs: readonly string[]
  blockers: readonly IntakeBuilderBlocker[]
}

const blocker = (code: string, path: string, message: string): IntakeBuilderBlocker => ({
  code,
  path,
  message,
})

export function projectIntakeBuilderLifecycle(input: IntakeBuilderLifecycleInput) {
  const evidenceRefs = [`intake-run:${input.runId}`]
  const fileUpload = input.fileUpload ?? null
  const fileExtraction = input.fileExtraction ?? null
  const stages = new Map<IntakeBuilderStage, IntakeBuilderLifecycleStage>()
  const set = (
    stage: IntakeBuilderStage,
    state: IntakeBuilderStageState,
    refs: readonly string[] = [],
    blockers: readonly IntakeBuilderBlocker[] = [],
  ) => stages.set(stage, { stage, state, evidenceRefs: refs, blockers })

  set('INGEST', 'COMPLETE', evidenceRefs)
  const researchRequired = input.sourceKind === 'WEBSITE'
  const fileUploadSource = input.sourceKind === 'FILE_UPLOAD'
  if (input.evidenceCount < 1 && !researchRequired) {
    set('NORMALIZE', 'BLOCKED', evidenceRefs, [
      blocker('MISSING_EVIDENCE', 'evidence', 'No normalized source evidence is available.'),
    ])
  } else {
    set(
      'NORMALIZE',
      'COMPLETE',
      input.evidenceCount > 0
        ? [...evidenceRefs, `evidence-count:${input.evidenceCount}`]
        : [...evidenceRefs, `website-source:${input.runId}`],
    )
  }

  const researchRefs = input.websiteResearch
    ? [
        ...evidenceRefs,
        `website-research:${input.websiteResearch.receiptId}`,
        `website-pages:${input.websiteResearch.fetchedPages}`,
        `website-bytes:${input.websiteResearch.fetchedBytes}`,
        `website-cost-units:${input.websiteResearch.estimatedCostUnits}`,
        `website-latency-ms:${input.websiteResearch.latencyMs}`,
      ]
    : evidenceRefs
  if (fileUploadSource && !fileUpload) {
    set('ANALYZE', 'BLOCKED', evidenceRefs, [
      blocker(
        'FILE_UPLOAD_EVIDENCE_INVALID',
        'fileUpload',
        'Stored upload evidence cannot be proven against one verified immutable file source.',
      ),
    ])
    set('RESEARCH', 'SKIPPED', ['policy:file-upload-does-not-require-public-research'])
  } else if (fileUploadSource && fileUpload) {
    const fileRefs = [
      ...evidenceRefs,
      `intake-upload:${fileUpload.uploadId}`,
      `intake-upload-sha256:${fileUpload.sha256}`,
    ]
    set('ANALYZE', 'COMPLETE', fileRefs)
    set('RESEARCH', 'SKIPPED', ['policy:file-upload-does-not-require-public-research'])
  } else if (researchRequired && input.websiteResearch === null) {
    set('ANALYZE', 'CURRENT', evidenceRefs)
    set('RESEARCH', 'BLOCKED', evidenceRefs, [
      blocker(
        'WEBSITE_RESEARCH_REQUIRED',
        'websiteResearch',
        'Run bounded website research before analysis can complete.',
      ),
    ])
  } else if (researchRequired && input.websiteResearch?.outcome !== 'SUCCEEDED') {
    const exhausted = !input.websiteResearch?.canRetry
    const code = input.websiteResearch?.errorCode ?? 'WEBSITE_RESEARCH_FAILED'
    const message =
      input.websiteResearch?.errorMessage ?? 'Website research did not retain a usable result.'
    set('ANALYZE', 'CURRENT', researchRefs)
    set('RESEARCH', 'BLOCKED', researchRefs, [
      blocker(
        exhausted ? 'WEBSITE_RESEARCH_LIMIT_REACHED' : code,
        'websiteResearch',
        exhausted ? `${message} The bounded attempt limit is reached.` : message,
      ),
    ])
  } else if (researchRequired && input.candidate === null) {
    set('ANALYZE', 'BLOCKED', researchRefs, [
      blocker(
        'WEBSITE_RESEARCH_EVIDENCE_INVALID',
        'websiteResearch',
        'Stored website research cannot be projected into reviewed Builder evidence.',
      ),
    ])
    set('RESEARCH', 'COMPLETE', researchRefs)
  } else if (input.candidate === null) {
    set('ANALYZE', 'BLOCKED', evidenceRefs, [
      blocker('SOURCE_NOT_SUPPORTED', 'sourceKind', 'This source has no reviewed Builder mapping.'),
    ])
    set('RESEARCH', 'PENDING')
  } else {
    set('ANALYZE', 'COMPLETE', [
      ...evidenceRefs,
      ...(input.candidate.candidateHash ? [`candidate:${input.candidate.candidateHash}`] : []),
    ])
    set(
      'RESEARCH',
      researchRequired ? 'COMPLETE' : 'SKIPPED',
      researchRequired ? researchRefs : ['policy:source-does-not-require-public-research'],
    )
  }

  const sourceBlocked = [...stages.values()].some(
    ({ stage, state }) =>
      ['NORMALIZE', 'ANALYZE', 'RESEARCH'].includes(stage) && state === 'BLOCKED',
  )
  if (fileUploadSource && !sourceBlocked && fileUpload) {
    const fileRefs = [
      ...evidenceRefs,
      `intake-upload:${fileUpload.uploadId}`,
      `intake-upload-sha256:${fileUpload.sha256}`,
    ]
    if (!fileExtraction) {
      set('EXTRACT', 'BLOCKED', fileRefs, [
        blocker(
          fileUpload.deterministicTextExtractionAvailable
            ? 'FILE_EXTRACTION_REQUIRED'
            : 'FILE_EXTRACTION_ADAPTER_REQUIRED',
          'fileUpload',
          fileUpload.deterministicTextExtractionAvailable
            ? 'The verified document is ready for one bounded deterministic text extraction.'
            : 'The verified file needs a source-specific document, OCR, image, audio, or video extraction adapter.',
        ),
      ])
      for (const stage of ['CONSTRUCT', 'RECONCILE', 'CLARIFY'] as const) set(stage, 'PENDING')
    } else if (fileExtraction.outcome === 'FAILED') {
      const extractionRefs = [...fileRefs, `file-extraction:${fileExtraction.receiptId}`]
      set('EXTRACT', 'BLOCKED', extractionRefs, [
        blocker(
          fileExtraction.errorCode ?? 'FILE_EXTRACTION_FAILED',
          'fileExtraction',
          fileExtraction.errorMessage ?? 'The deterministic file extraction failed closed.',
        ),
      ])
      for (const stage of ['CONSTRUCT', 'RECONCILE', 'CLARIFY'] as const) set(stage, 'PENDING')
    } else {
      const extractionRefs = [
        ...fileRefs,
        `file-extraction:${fileExtraction.receiptId}`,
        ...(fileExtraction.extractedTextHash
          ? [`file-extraction-sha256:${fileExtraction.extractedTextHash}`]
          : []),
      ]
      set('EXTRACT', 'COMPLETE', extractionRefs)
      if (!fileExtraction.review) {
        set('CONSTRUCT', 'BLOCKED', extractionRefs, [
          blocker(
            'FILE_EXTRACTION_REVIEW_REQUIRED',
            'fileExtraction',
            'The deterministic extraction is retained for review but cannot become structured venue content without a separate exact review.',
          ),
        ])
        set('RECONCILE', 'PENDING')
        set('CLARIFY', 'PENDING')
      } else if (fileExtraction.review.decision === 'REJECTED') {
        const reviewRefs = [
          ...extractionRefs,
          `file-extraction-review:${fileExtraction.review.reviewId}`,
        ]
        set('CONSTRUCT', 'BLOCKED', reviewRefs, [
          blocker(
            'FILE_EXTRACTION_REJECTED',
            'fileExtraction.review',
            'A human reviewer rejected this extraction for proposal use. No structured proposal was created.',
          ),
        ])
        set('RECONCILE', 'PENDING')
        set('CLARIFY', 'PENDING')
      } else {
        const reviewRefs = [
          ...extractionRefs,
          `file-extraction-review:${fileExtraction.review.reviewId}`,
          `structured-proposal:${fileExtraction.review.proposalRunId}`,
          ...(fileExtraction.review.proposalNotesHash
            ? [`structured-proposal-sha256:${fileExtraction.review.proposalNotesHash}`]
            : []),
        ]
        set('CONSTRUCT', 'COMPLETE', reviewRefs)
        set('RECONCILE', 'BLOCKED', reviewRefs, [
          blocker(
            'STRUCTURED_PROPOSAL_REVIEW_REQUIRED',
            'fileExtraction.review.proposalRunId',
            'Reviewed notes created a separate awaiting-review structured proposal. It still requires canonical proposal review before any package mapping.',
          ),
        ])
        set('CLARIFY', 'PENDING')
      }
    }
  } else if (sourceBlocked || input.candidate === null) {
    for (const stage of ['EXTRACT', 'CONSTRUCT', 'RECONCILE', 'CLARIFY'] as const) {
      if (!stages.has(stage)) set(stage, 'PENDING')
    }
  } else {
    const candidateRefs = [
      ...evidenceRefs,
      ...(input.candidate.candidateHash ? [`candidate:${input.candidate.candidateHash}`] : []),
    ]
    const candidateIssues =
      !input.candidate.ready && input.candidate.issues.length === 0
        ? [
            blocker(
              'CANDIDATE_NOT_READY',
              'candidate',
              'The candidate is not ready and did not provide actionable issue evidence.',
            ),
          ]
        : input.candidate.issues
    if (input.candidate.candidateCount < 1) {
      set('EXTRACT', 'BLOCKED', candidateRefs, candidateIssues)
    } else {
      set('EXTRACT', 'COMPLETE', candidateRefs)
    }
    if (candidateIssues.length > 0) {
      set('CONSTRUCT', 'PENDING')
      set('RECONCILE', 'BLOCKED', candidateRefs, candidateIssues)
      set('CLARIFY', 'BLOCKED', candidateRefs, candidateIssues)
    } else if (!input.packageDraft) {
      set('CONSTRUCT', 'CURRENT', candidateRefs)
      set('RECONCILE', 'COMPLETE', candidateRefs)
      set('CLARIFY', 'SKIPPED', ['policy:no-unresolved-candidate-issues'])
    } else {
      const packageRefs = [...candidateRefs, `venue-package:${input.packageDraft.id}`]
      set('CONSTRUCT', 'COMPLETE', packageRefs)
      set('RECONCILE', 'COMPLETE', packageRefs)
      set('CLARIFY', 'SKIPPED', ['policy:no-unresolved-candidate-issues'])
    }
  }

  const packageDraft = input.packageDraft
  if (!packageDraft) {
    for (const stage of ['VALIDATE', 'SIMULATE', 'QA', 'REVIEW', 'READY', 'PUBLISH'] as const) {
      set(stage, 'PENDING')
    }
  } else {
    const packageRefs = [`venue-package:${packageDraft.id}`]
    const invalidPackageEvidence: IntakeBuilderBlocker[] = []
    if (packageDraft.validationEvidence === 'INVALID') {
      invalidPackageEvidence.push(
        blocker(
          'INVALID_VALIDATION_EVIDENCE',
          'validationReport',
          'Stored package validation evidence is invalid.',
        ),
      )
    }
    if (packageDraft.simulationEvidence === 'INVALID') {
      invalidPackageEvidence.push(
        blocker(
          'INVALID_SIMULATION_EVIDENCE',
          'previewPlan',
          'Stored package simulation evidence is invalid.',
        ),
      )
    }
    set(
      'VALIDATE',
      packageDraft.validationEvidence === 'VALID' ? 'COMPLETE' : 'BLOCKED',
      packageRefs,
      invalidPackageEvidence.filter(({ code }) => code === 'INVALID_VALIDATION_EVIDENCE'),
    )
    set(
      'SIMULATE',
      packageDraft.simulationEvidence === 'VALID' ? 'COMPLETE' : 'BLOCKED',
      packageRefs,
      invalidPackageEvidence.filter(({ code }) => code === 'INVALID_SIMULATION_EVIDENCE'),
    )
    if (invalidPackageEvidence.length > 0) {
      set('QA', 'PENDING')
      set('REVIEW', 'PENDING')
    } else if (packageDraft.semanticQa === 'COMPLETE') {
      set('QA', 'COMPLETE', [...packageRefs, 'semantic-qa:complete'])
      set('REVIEW', packageDraft.status === 'DRAFT' ? 'CURRENT' : 'COMPLETE', packageRefs)
    } else if (packageDraft.semanticQa === 'RUNNING') {
      set('QA', 'CURRENT', [...packageRefs, 'semantic-qa:running'])
      set('REVIEW', 'PENDING')
    } else {
      set('QA', 'BLOCKED', packageRefs, [
        blocker(
          packageDraft.semanticQa === 'MISSING'
            ? 'SEMANTIC_QA_MISSING'
            : `SEMANTIC_QA_${packageDraft.semanticQa}`,
          'duplicateAnalysis',
          'Semantic package QA is not complete.',
        ),
      ])
      set('REVIEW', 'PENDING')
    }

    const ready = packageDraft.status === 'APPROVED' || packageDraft.status === 'APPLIED'
    set(
      'READY',
      ready ? 'COMPLETE' : packageDraft.status === 'REVERTED' ? 'BLOCKED' : 'PENDING',
      packageRefs,
      packageDraft.status === 'REVERTED'
        ? [
            blocker(
              'PACKAGE_REVERTED',
              'status',
              'The package was reverted and is not launch-ready.',
            ),
          ]
        : [],
    )
    set(
      'PUBLISH',
      packageDraft.status === 'APPLIED'
        ? 'COMPLETE'
        : packageDraft.status === 'APPROVED'
          ? 'CURRENT'
          : packageDraft.status === 'REVERTED'
            ? 'BLOCKED'
            : 'PENDING',
      packageRefs,
      packageDraft.status === 'REVERTED'
        ? [blocker('PACKAGE_REVERTED', 'status', 'A reverted package cannot remain published.')]
        : [],
    )
  }

  const orderedStages = INTAKE_BUILDER_STAGES.map((stage) => stages.get(stage)!)
  const current =
    orderedStages.find(({ state }) => state === 'BLOCKED') ??
    orderedStages.find(({ state }) => state === 'CURRENT') ??
    orderedStages.find(({ state }) => state === 'PENDING') ??
    orderedStages.at(-1)!

  let nextAction: IntakeBuilderNextAction = 'NONE'
  if (current.stage === 'ANALYZE' || current.stage === 'RESEARCH') {
    nextAction = fileUploadSource
      ? 'REVIEW_FILE_SOURCE'
      : input.sourceKind !== 'WEBSITE'
        ? 'RESOLVE_CLARIFICATION'
        : input.websiteResearch === null
          ? 'RUN_WEBSITE_RESEARCH'
          : input.websiteResearch.outcome !== 'SUCCEEDED'
            ? input.websiteResearch.canRetry
              ? 'RETRY_WEBSITE_RESEARCH'
              : 'REVIEW_WEBSITE_SOURCE'
            : 'RESOLVE_CLARIFICATION'
  } else if (current.stage === 'EXTRACT' && fileUploadSource) {
    nextAction =
      !fileExtraction && fileUpload?.deterministicTextExtractionAvailable
        ? 'RUN_FILE_EXTRACTION'
        : fileExtraction?.outcome === 'SUCCEEDED'
          ? 'REVIEW_FILE_EXTRACTION'
          : 'REVIEW_FILE_SOURCE'
  } else if (
    current.stage === 'NORMALIZE' ||
    current.stage === 'EXTRACT' ||
    current.stage === 'RECONCILE' ||
    current.stage === 'CLARIFY'
  ) {
    nextAction = fileUploadSource
      ? fileExtraction?.review?.decision === 'ACCEPTED_FOR_PROPOSAL'
        ? 'REVIEW_STRUCTURED_PROPOSAL'
        : 'REVIEW_FILE_SOURCE'
      : 'RESOLVE_CLARIFICATION'
  } else if (current.stage === 'CONSTRUCT') {
    nextAction = fileUploadSource
      ? fileExtraction?.review?.decision === 'REJECTED'
        ? 'REVIEW_FILE_SOURCE'
        : 'REVIEW_FILE_EXTRACTION'
      : 'CREATE_PACKAGE_DRAFT'
  } else if (current.stage === 'VALIDATE' || current.stage === 'SIMULATE') {
    nextAction = 'REPAIR_PACKAGE_EVIDENCE'
  } else if (current.stage === 'QA') {
    nextAction =
      packageDraft?.semanticQa === 'RUNNING' ? 'WAIT_FOR_SEMANTIC_QA' : 'RETRY_SEMANTIC_QA'
  } else if (current.stage === 'REVIEW') {
    nextAction = 'REVIEW_PACKAGE'
  } else if (current.stage === 'READY') {
    nextAction = packageDraft?.status === 'REVERTED' ? 'REVIEW_REVERTED_PACKAGE' : 'APPROVE_PACKAGE'
  } else if (current.stage === 'PUBLISH') {
    nextAction = packageDraft?.status === 'REVERTED' ? 'REVIEW_REVERTED_PACKAGE' : 'APPLY_PACKAGE'
  }

  return {
    schemaVersion: 1 as const,
    runId: input.runId,
    sourceKind: input.sourceKind,
    runStatus: input.runStatus,
    websiteResearch: input.websiteResearch,
    fileUpload,
    fileExtraction,
    currentStage: current.stage,
    currentState: current.state,
    nextAction,
    requiresHumanApproval: nextAction === 'APPROVE_PACKAGE' || nextAction === 'APPLY_PACKAGE',
    stages: orderedStages,
    autoApprove: false as const,
    autoApply: false as const,
    autoPublish: false as const,
  }
}
