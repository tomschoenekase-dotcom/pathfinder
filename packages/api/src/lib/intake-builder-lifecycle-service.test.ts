import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getIntakeBuilderLifecycle } from './intake-builder-lifecycle-service'
import { buildIntakeVenuePackageCandidate } from './intake-venue-package-candidate'
import { loadInterviewClarificationReview } from './intake-interview-clarifications'

vi.mock('./intake-venue-package-candidate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./intake-venue-package-candidate')>()
  return { ...actual, buildIntakeVenuePackageCandidate: vi.fn() }
})
vi.mock('./intake-interview-clarifications', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./intake-interview-clarifications')>()
  return { ...actual, loadInterviewClarificationReview: vi.fn() }
})

const buildCandidate = vi.mocked(buildIntakeVenuePackageCandidate)
const loadInterviewReview = vi.mocked(loadInterviewClarificationReview)

describe('getIntakeBuilderLifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('proves one verified immutable file source and preserves the extraction boundary', async () => {
    const verifiedAt = new Date('2026-08-29T02:00:00.000Z')
    const sha256 = 'c'.repeat(64)
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-file',
      sourceKind: 'FILE_UPLOAD',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      evidence: [
        {
          id: 'evidence-file',
          sourceKind: 'FILE_UPLOAD',
          locator: 'intake-upload:upload-a',
          normalizedHash: sha256,
          confidence: 1,
        },
      ],
      upload: {
        id: 'upload-a',
        displayName: 'Visitor guide source',
        fileName: 'visitor-guide.pdf',
        mimeType: 'application/pdf',
        category: 'DOCUMENT',
        byteSize: 4096,
        sha256,
        status: 'AWAITING_REVIEW',
        verifiedAt,
      },
      fileExtractionReceipts: [],
      websiteResearchReceipts: [],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-file',
    })

    expect(buildCandidate).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      currentStage: 'EXTRACT',
      currentState: 'BLOCKED',
      nextAction: 'REVIEW_FILE_SOURCE',
      fileUpload: {
        uploadId: 'upload-a',
        displayName: 'Visitor guide source',
        fileName: 'visitor-guide.pdf',
        mimeType: 'application/pdf',
        category: 'DOCUMENT',
        byteSize: 4096,
        sha256,
        verifiedAt,
        deterministicTextExtractionAvailable: false,
      },
    })
    expect(result.stages.find(({ stage }) => stage === 'EXTRACT')?.blockers).toEqual([
      expect.objectContaining({ code: 'FILE_EXTRACTION_ADAPTER_REQUIRED' }),
    ])
  })

  it('exposes a terminal accepted extraction review as an awaiting-review proposal only', async () => {
    const verifiedAt = new Date('2026-08-29T02:00:00.000Z')
    const sha256 = 'c'.repeat(64)
    const textHash = 'd'.repeat(64)
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-file',
      sourceKind: 'FILE_UPLOAD',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      evidence: [
        {
          id: 'evidence-file',
          sourceKind: 'FILE_UPLOAD',
          locator: 'intake-upload:upload-a',
          normalizedHash: sha256,
          confidence: 1,
        },
      ],
      upload: {
        id: 'upload-a',
        displayName: 'Staff notes',
        fileName: 'staff-notes.txt',
        mimeType: 'text/plain',
        category: 'DOCUMENT',
        byteSize: 18,
        sha256,
        status: 'AWAITING_REVIEW',
        verifiedAt,
      },
      fileExtractionReceipts: [
        {
          id: '968c2e1a-8ece-47ad-98dc-e4bde64872ca',
          outcome: 'SUCCEEDED',
          extractor: 'pathfinder-utf8-document',
          extractorVersion: '1',
          extractedText: 'Line one\nLine two',
          extractedTextHash: textHash,
          extractedCharacterCount: 18,
          extractedLineCount: 2,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date('2026-08-29T03:00:00.000Z'),
          review: {
            id: 'a68c2e1a-8ece-47ad-98dc-e4bde64872ca',
            decision: 'ACCEPTED_FOR_PROPOSAL',
            proposalRunId: 'proposal-a',
            proposalTitle: 'Reviewed staff notes',
            proposalNotesHash: 'e'.repeat(64),
            rationale: 'The notes are legible and relevant.',
            createdBy: 'admin-a',
            createdAt: new Date('2026-08-29T03:05:00.000Z'),
            proposalRun: { status: 'AWAITING_REVIEW' },
          },
        },
      ],
      websiteResearchReceipts: [],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: vi.fn().mockResolvedValue([]) },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-file',
    })

    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      nextAction: 'REVIEW_STRUCTURED_PROPOSAL',
      fileExtractionReview: {
        receiptId: '968c2e1a-8ece-47ad-98dc-e4bde64872ca',
        reviewRequired: false,
        grantsAuthority: false,
        review: {
          decision: 'ACCEPTED_FOR_PROPOSAL',
          proposalRunId: 'proposal-a',
          proposalStatus: 'AWAITING_REVIEW',
          rationale: 'The notes are legible and relevant.',
        },
      },
      autoApprove: false,
      autoApply: false,
      autoPublish: false,
    })
  })

  it('carries unresolved local file clarification evidence into proposal and package review', async () => {
    const receiptId = '968c2e1a-8ece-47ad-98dc-e4bde64872ca'
    const textHash = 'd'.repeat(64)
    buildCandidate.mockResolvedValueOnce({
      runId: 'proposal-a',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      ready: true,
      payload: {
        schemaVersion: 3,
        places: { create: [], update: [], delete: [] },
        knowledgeEntries: { create: [], update: [], delete: [] },
      },
      candidateHash: 'f'.repeat(64),
      issues: [],
      summary: { candidateCount: 1, issueCount: 0 },
      autoApprove: false,
      autoApply: false,
      published: false,
    } as never)
    const findFirst = vi.fn().mockResolvedValue({
      id: 'proposal-a',
      sourceKind: 'STRUCTURED_BOOTSTRAP',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      evidence: [
        {
          id: 'proposal-evidence',
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          locator: 'intake-file-extraction-review:review-a',
          normalizedHash: 'e'.repeat(64),
          confidence: 1,
        },
      ],
      upload: null,
      fileExtractionReceipts: [],
      fileExtractionProposalReview: {
        sourceRunId: 'source-run-a',
        receiptId,
        expectedExtractedTextHash: textHash,
      },
      websiteResearchReceipts: [],
      packageHandoff: {
        packageDraft: {
          id: 'draft-a',
          status: 'DRAFT',
          validationReport: {},
          previewPlan: {},
          duplicateAnalysis: { status: 'COMPLETE' },
        },
      },
    })
    const questionFindMany = vi.fn().mockResolvedValue([
      {
        id: 'question-local',
        question: 'Which holiday schedule applies?',
        status: 'PENDING',
        answer: null,
        evidence: [],
        callbackMetadata: {
          receiptId,
          fieldPath: 'venue.operations.holidayHours',
          reason: 'DATE_SENSITIVE',
          blockerScope: 'LOCAL',
        },
        blocking: false,
        agentIdentityId: 'identity-a',
        updatedAt: new Date('2026-08-29T03:35:00.000Z'),
      },
    ])

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: questionFindMany },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'proposal-a',
    })

    expect(result.fileClarificationReview).toMatchObject({
      receiptId,
      sourceRunId: 'source-run-a',
      carriedForward: true,
      canCreate: false,
      foundationalPending: 0,
      localPending: 1,
      questions: [
        {
          id: 'question-local',
          blockerScope: 'LOCAL',
          blocksTerminalReview: false,
          status: 'PENDING',
        },
      ],
    })
    expect(result.nextAction).toBe('REPAIR_PACKAGE_EVIDENCE')
  })

  it('uses exact scope and exposes research for a newly recorded zero-evidence website source', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 0 },
      websiteResearchReceipts: [],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'run-a', tenantId: 'tenant-a', venueId: 'venue-a' },
      }),
    )
    expect(buildCandidate).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      currentStage: 'RESEARCH',
      currentState: 'BLOCKED',
      nextAction: 'RUN_WEBSITE_RESEARCH',
    })
    expect(result.stages.find(({ stage }) => stage === 'NORMALIZE')).toMatchObject({
      state: 'COMPLETE',
      evidenceRefs: expect.arrayContaining(['website-source:run-a']),
    })
  })

  it('projects malformed stored package evidence as a blocker', async () => {
    buildCandidate.mockResolvedValueOnce({
      runId: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      ready: true,
      payload: {} as never,
      candidateHash: 'a'.repeat(64),
      issues: [],
      summary: { candidateCount: 1, issueCount: 0 },
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 2 },
      websiteResearchReceipts: [],
      packageHandoff: {
        packageDraft: {
          id: 'package-a',
          status: 'DRAFT',
          validationReport: {},
          previewPlan: {},
          duplicateAnalysis: { status: 'COMPLETE' },
        },
      },
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(buildCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        runId: 'run-a',
        allowExistingHandoff: true,
      }),
    )
    expect(result).toMatchObject({
      currentStage: 'VALIDATE',
      currentState: 'BLOCKED',
      nextAction: 'REPAIR_PACKAGE_EVIDENCE',
    })
  })

  it('projects retained website citations into an explicitly unmapped review candidate', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      websiteResearchReceipts: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          outcome: 'SUCCEEDED',
          researchSnapshot: {
            schemaVersion: 1,
            sourceId: 'run-a',
            pages: [
              {
                url: 'https://example.org/',
                depth: 0,
                byteSize: 10,
                normalizedHash: 'a'.repeat(64),
              },
            ],
            citations: [
              {
                evidenceId: 'evidence-a',
                fieldPath: 'venue.name',
                value: 'Example Hall',
                sourceUrl: 'https://example.org/',
                locator: 'title',
                confidence: 0.9,
                dateSensitive: false,
                effectiveDate: null,
              },
            ],
            evidence: [],
            discrepancies: [],
          },
          candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
          attemptedFetches: 1,
          fetchedPages: 1,
          fetchedBytes: 10,
          estimatedCostUnits: 2,
          latencyMs: 40,
          errorCode: null,
          errorMessage: null,
        },
      ],
      packageHandoff: null,
    })

    const result = await getIntakeBuilderLifecycle({
      db: { intakeRun: { findFirst } } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      nextAction: 'RESOLVE_CLARIFICATION',
      websiteResearch: {
        outcome: 'SUCCEEDED',
        attemptCount: 1,
        canRetry: false,
        fetchedPages: 1,
      },
    })
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')?.blockers).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'WEBSITE_MAPPING_REQUIRED' })]),
    )
  })

  it('projects interview discrepancies into durable answerable guidance without granting authority', async () => {
    buildCandidate.mockResolvedValueOnce({
      runId: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      ready: false,
      payload: null,
      candidateHash: null,
      issues: [
        {
          code: 'INTERVIEW_DISCREPANCY',
          path: 'venue.operations.hours',
          message: 'Resolve LOW_CONFIDENCE before creating a package candidate.',
        },
      ],
      summary: { candidateCount: 1, issueCount: 1 },
      autoApprove: false,
      autoApply: false,
      published: false,
    })
    loadInterviewReview.mockResolvedValueOnce({
      reviewHash: 'a'.repeat(64),
      clarifications: [
        {
          clarificationId: 'interview-clarification-a',
          questionId: 'operations.hours',
          fieldPath: 'venue.operations.hours',
          reasons: ['LOW_CONFIDENCE'],
          operationId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          question: 'Please confirm the hours.',
          context: 'Guidance only.',
          questionType: 'LONG_TEXT',
          choices: [],
          evidence: [
            {
              label: 'What are the hours?',
              reference: 'intake-evidence:evidence-a',
              summary: 'Open nine to five. · 55% confidence',
            },
          ],
          proposedAnswer: {
            value: 'Open nine to five.',
            confidence: 0.55,
            evidenceId: 'evidence-a',
            status: 'PROPOSED_ONLY',
          },
        },
      ],
    })
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'INTERVIEW',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      websiteResearchReceipts: [],
      packageHandoff: null,
    })
    const questionFindMany = vi.fn().mockResolvedValue([
      {
        id: 'question-a',
        operationId: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
        status: 'ANSWERED',
        answer: 'Use nine to five.',
        agentIdentityId: 'identity-a',
        updatedAt: new Date('2026-08-28T23:00:00.000Z'),
      },
    ])

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: questionFindMany },
        agentIdentity: {
          findMany: vi.fn().mockResolvedValue([{ id: 'identity-a', name: 'Content' }]),
        },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result).toMatchObject({
      currentStage: 'RECONCILE',
      nextAction: 'RESOLVE_CLARIFICATION',
      interviewClarificationReview: {
        reviewHash: 'a'.repeat(64),
        answersGrantAuthority: false,
        sourceAmendmentRequired: true,
        clarifications: [
          {
            clarificationId: 'interview-clarification-a',
            question: {
              id: 'question-a',
              status: 'ANSWERED',
              answer: 'Use nine to five.',
              answerGuidanceOnly: true,
            },
          },
        ],
      },
    })
  })

  it('reads durable clarification answers as guidance while keeping mapping blocked', async () => {
    const researchSnapshot = {
      schemaVersion: 1,
      sourceId: 'run-a',
      pages: [],
      citations: [
        {
          evidenceId: 'evidence-a',
          fieldPath: 'venue.name',
          value: 'Example Hall',
          sourceUrl: 'https://example.org/',
          locator: 'title',
          confidence: 0.9,
          dateSensitive: false,
          effectiveDate: null,
        },
        {
          evidenceId: 'evidence-b',
          fieldPath: 'venue.name',
          value: 'Example Ballroom',
          sourceUrl: 'https://example.org/about',
          locator: 'meta title',
          confidence: 0.7,
          dateSensitive: false,
          effectiveDate: null,
        },
      ],
      evidence: [],
      discrepancies: [
        {
          id: 'discrepancy-a',
          fieldPath: 'venue.name',
          evidenceIds: ['evidence-a', 'evidence-b'],
          reason: 'CONTRADICTION',
        },
      ],
    }
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-a',
      sourceKind: 'WEBSITE',
      status: 'AWAITING_REVIEW',
      _count: { evidence: 1 },
      websiteResearchReceipts: [
        {
          id: '768c2e1a-8ece-47ad-98dc-e4bde64872ca',
          outcome: 'SUCCEEDED',
          researchSnapshot,
          candidateSnapshot: { kind: 'TYPED_INTERMEDIATE', draftInput: null },
          attemptedFetches: 2,
          fetchedPages: 2,
          fetchedBytes: 20,
          estimatedCostUnits: 3,
          latencyMs: 50,
          errorCode: null,
          errorMessage: null,
        },
      ],
      packageHandoff: null,
    })
    const questionFindMany = vi.fn().mockImplementation(({ where }) =>
      Promise.resolve([
        {
          id: 'question-a',
          operationId: where.operationId.in[0],
          status: 'ANSWERED',
          answer: 'Use Example Hall.',
          agentIdentityId: 'identity-a',
          updatedAt: new Date('2026-08-25T20:00:00.000Z'),
        },
      ]),
    )

    const result = await getIntakeBuilderLifecycle({
      db: {
        intakeRun: { findFirst },
        agentQuestion: { findMany: questionFindMany },
        agentIdentity: {
          findMany: vi.fn().mockResolvedValue([{ id: 'identity-a', name: 'Content' }]),
        },
      } as never,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
    })

    expect(result.websiteClarificationReview).toMatchObject({
      answersGrantAuthority: false,
      clarifications: [
        {
          discrepancyId: 'discrepancy-a',
          question: {
            id: 'question-a',
            status: 'ANSWERED',
            answer: 'Use Example Hall.',
            answerGuidanceOnly: true,
          },
        },
      ],
    })
    expect(result.currentStage).toBe('RECONCILE')
    expect(result.stages.find(({ stage }) => stage === 'RECONCILE')?.blockers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining('guidance only') }),
        expect.objectContaining({ code: 'WEBSITE_MAPPING_REQUIRED' }),
      ]),
    )
  })
})
