import { describe, expect, it } from 'vitest'

import { INTAKE_BUILDER_STAGES, projectIntakeBuilderLifecycle } from './intake-builder-lifecycle'

const base = {
  runId: 'run-a',
  sourceKind: 'INTERVIEW',
  runStatus: 'AWAITING_REVIEW',
  evidenceCount: 2,
  websiteResearch: null,
  candidate: {
    ready: true,
    candidateHash: 'a'.repeat(64),
    candidateCount: 2,
    issues: [],
  },
  packageDraft: null,
} as const

describe('intake Builder lifecycle projection', () => {
  it('exposes the full ordered lifecycle and stops at durable package construction', () => {
    const result = projectIntakeBuilderLifecycle(base)
    expect(result.stages.map(({ stage }) => stage)).toEqual(INTAKE_BUILDER_STAGES)
    expect(result).toMatchObject({
      currentStage: 'CONSTRUCT',
      currentState: 'CURRENT',
      nextAction: 'CREATE_PACKAGE_DRAFT',
      requiresHumanApproval: false,
      autoPublish: false,
    })
    expect(result.stages.find(({ stage }) => stage === 'RESEARCH')).toMatchObject({
      state: 'SKIPPED',
    })
  })

  it('turns candidate discrepancies into a visible clarification blocker', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      candidate: {
        ...base.candidate,
        ready: false,
        issues: [{ code: 'INTERVIEW_DISCREPANCY', path: 'hours', message: 'Hours conflict.' }],
      },
    })
    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      currentState: 'BLOCKED',
      nextAction: 'RESOLVE_CLARIFICATION',
    })
    expect(result.stages.find(({ stage }) => stage === 'CLARIFY')).toMatchObject({
      state: 'BLOCKED',
      blockers: [expect.objectContaining({ code: 'INTERVIEW_DISCREPANCY' })],
    })
  })

  it('fails a not-ready candidate closed when upstream omitted issue details', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      candidate: { ...base.candidate, ready: false, issues: [] },
    })
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')).toMatchObject({
      state: 'BLOCKED',
      blockers: [expect.objectContaining({ code: 'CANDIDATE_NOT_READY' })],
    })
  })

  it('treats the recorded website source as normalized input and requires bounded research', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'WEBSITE',
      evidenceCount: 0,
      candidate: null,
    })
    expect(result).toMatchObject({
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RUN_WEBSITE_RESEARCH',
    })
    expect(result.stages.find(({ stage }) => stage === 'EXTRACT')).toMatchObject({
      state: 'PENDING',
    })
    expect(result.stages.find(({ stage }) => stage === 'NORMALIZE')).toMatchObject({
      state: 'COMPLETE',
      evidenceRefs: expect.arrayContaining(['website-source:run-a']),
    })
  })

  it('projects retryable, exhausted, and successful website research truth', () => {
    const failedResearch = {
      receiptId: 'receipt-a',
      outcome: 'FAILED' as const,
      attemptCount: 1,
      canRetry: true,
      attemptedFetches: 1,
      fetchedPages: 0,
      fetchedBytes: 0,
      estimatedCostUnits: 0,
      latencyMs: 25,
      errorCode: 'TIME_LIMIT',
      errorMessage: 'The bounded crawl reached its time limit.',
    }
    const retryable = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'WEBSITE',
      candidate: null,
      websiteResearch: failedResearch,
    })
    expect(retryable).toMatchObject({
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RETRY_WEBSITE_RESEARCH',
    })
    expect(retryable.stages.find(({ stage }) => stage === 'RESEARCH')?.evidenceRefs).toContain(
      'website-research:receipt-a',
    )

    const exhausted = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'WEBSITE',
      candidate: null,
      websiteResearch: { ...failedResearch, attemptCount: 4, canRetry: false },
    })
    expect(exhausted.nextAction).toBe('REVIEW_WEBSITE_SOURCE')

    const succeeded = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'WEBSITE',
      websiteResearch: { ...failedResearch, outcome: 'SUCCEEDED', canRetry: false },
      candidate: {
        ready: false,
        candidateHash: 'b'.repeat(64),
        candidateCount: 2,
        issues: [
          {
            code: 'WEBSITE_MAPPING_REQUIRED',
            path: 'candidate',
            message: 'Mapping requires review.',
          },
        ],
      },
    })
    expect(succeeded).toMatchObject({
      currentStage: 'RECONCILE',
      nextAction: 'RESOLVE_CLARIFICATION',
    })
    expect(succeeded.stages.find(({ stage }) => stage === 'RESEARCH')).toMatchObject({
      state: 'COMPLETE',
    })
  })

  it('retains verified file progress and stops at reviewed extraction without authority', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'FILE_UPLOAD',
      evidenceCount: 1,
      candidate: null,
      fileUpload: {
        uploadId: 'upload-a',
        displayName: 'Visitor guide source',
        fileName: 'visitor-guide.pdf',
        mimeType: 'application/pdf',
        category: 'DOCUMENT',
        byteSize: 4096,
        sha256: 'c'.repeat(64),
        verifiedAt: new Date('2026-08-29T02:00:00.000Z'),
        deterministicTextExtractionAvailable: false,
      },
    })

    expect(result).toMatchObject({
      currentStage: 'EXTRACT',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_FILE_SOURCE',
      requiresHumanApproval: false,
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
    })
    expect(result.stages.find(({ stage }) => stage === 'ANALYZE')).toMatchObject({
      state: 'COMPLETE',
      evidenceRefs: expect.arrayContaining([
        'intake-upload:upload-a',
        `intake-upload-sha256:${'c'.repeat(64)}`,
      ]),
    })
    expect(result.stages.find(({ stage }) => stage === 'RESEARCH')).toMatchObject({
      state: 'SKIPPED',
    })
    expect(result.stages.find(({ stage }) => stage === 'EXTRACT')).toMatchObject({
      blockers: [expect.objectContaining({ code: 'FILE_EXTRACTION_ADAPTER_REQUIRED' })],
    })
  })

  it('offers bounded text extraction and then stops successful output at exact review', () => {
    const fileUpload = {
      uploadId: 'upload-a',
      displayName: 'Staff notes',
      fileName: 'staff-notes.txt',
      mimeType: 'text/plain',
      category: 'DOCUMENT',
      byteSize: 120,
      sha256: 'c'.repeat(64),
      verifiedAt: new Date('2026-08-29T02:00:00.000Z'),
      deterministicTextExtractionAvailable: true,
    } as const
    const ready = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'FILE_UPLOAD',
      evidenceCount: 1,
      candidate: null,
      fileUpload,
    })
    expect(ready).toMatchObject({
      currentStage: 'EXTRACT',
      currentState: 'BLOCKED',
      nextAction: 'RUN_FILE_EXTRACTION',
    })

    const extracted = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'FILE_UPLOAD',
      evidenceCount: 1,
      candidate: null,
      fileUpload,
      fileExtraction: {
        receiptId: 'receipt-a',
        outcome: 'SUCCEEDED',
        extractor: 'pathfinder-utf8-document',
        extractorVersion: '1',
        extractedTextHash: 'd'.repeat(64),
        extractedCharacterCount: 12,
        extractedLineCount: 2,
        errorCode: null,
        errorMessage: null,
      },
    })
    expect(extracted).toMatchObject({
      currentStage: 'CONSTRUCT',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_FILE_EXTRACTION',
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
    })
    expect(extracted.stages.find(({ stage }) => stage === 'EXTRACT')).toMatchObject({
      state: 'COMPLETE',
      evidenceRefs: expect.arrayContaining(['file-extraction:receipt-a']),
    })
  })

  it('fails a file source closed when immutable verification evidence is unavailable', () => {
    const result = projectIntakeBuilderLifecycle({
      ...base,
      sourceKind: 'FILE_UPLOAD',
      evidenceCount: 1,
      candidate: null,
      fileUpload: null,
    })
    expect(result).toMatchObject({
      currentStage: 'ANALYZE',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_FILE_SOURCE',
    })
    expect(result.stages.find(({ stage }) => stage === 'ANALYZE')?.blockers).toEqual([
      expect.objectContaining({ code: 'FILE_UPLOAD_EVIDENCE_INVALID' }),
    ])
  })

  it('requires semantic QA before review and preserves human publication authority', () => {
    const running = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'DRAFT',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'RUNNING',
      },
    })
    expect(running).toMatchObject({
      currentStage: 'QA',
      currentState: 'CURRENT',
      nextAction: 'WAIT_FOR_SEMANTIC_QA',
    })

    const approved = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'APPROVED',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(approved).toMatchObject({
      currentStage: 'PUBLISH',
      currentState: 'CURRENT',
      nextAction: 'APPLY_PACKAGE',
      requiresHumanApproval: true,
      autoApply: false,
      autoPublish: false,
    })
  })

  it('reports exact invalid stored evidence and reverted package boundaries', () => {
    const invalid = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'DRAFT',
        validationEvidence: 'INVALID',
        simulationEvidence: 'INVALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(invalid).toMatchObject({
      currentStage: 'VALIDATE',
      currentState: 'BLOCKED',
      nextAction: 'REPAIR_PACKAGE_EVIDENCE',
    })

    const reverted = projectIntakeBuilderLifecycle({
      ...base,
      packageDraft: {
        id: 'package-a',
        status: 'REVERTED',
        validationEvidence: 'VALID',
        simulationEvidence: 'VALID',
        semanticQa: 'COMPLETE',
      },
    })
    expect(reverted).toMatchObject({
      currentStage: 'READY',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_REVERTED_PACKAGE',
    })
  })
})
