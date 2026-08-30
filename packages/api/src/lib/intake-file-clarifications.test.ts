import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ askQuestion: vi.fn() }))

vi.mock('@pathfinder/db', () => ({
  AgentQuestionActionError: class AgentQuestionActionError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
  askAgentQuestionAction: mocks.askQuestion,
}))

import {
  createFileExtractionClarificationQuestion,
  resolveFileExtractionClarification,
} from './intake-file-clarifications'

const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
const textHash = 'a'.repeat(64)
const answeredAt = new Date('2026-08-29T17:00:00.000Z')
const resolutionRequestId = 'b79ca1f5-9c21-498e-890e-88ddb889f9b4'

function input(db: unknown, overrides: Record<string, unknown> = {}) {
  return {
    db,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    runId: 'run-a',
    receiptId,
    expectedExtractedTextHash: textHash,
    fieldPath: 'knowledge.arrival',
    reason: 'MISSING_CONTEXT',
    blockerScope: 'LOCAL',
    question: 'Which entrance should first-time visitors use?',
    evidenceExcerpt: 'Guests should use the east entrance.',
    agentIdentityId: 'identity-a',
    ...overrides,
  } as never
}

describe('file extraction clarification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.askQuestion.mockResolvedValue({
      question: { id: 'question-a', status: 'PENDING' },
      replayed: false,
    })
  })

  it('binds one replay-safe guidance question to an exact retained excerpt', async () => {
    const db = {
      intakeFileExtractionReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          extractedText: 'Welcome. Guests should use the east entrance. Thank you.',
          extractedTextHash: textHash,
          review: null,
        }),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
    }
    const result = await createFileExtractionClarificationQuestion(input(db))

    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-a',
        venueId: 'venue-a',
        agentIdentityId: 'identity-a',
        category: 'builder-file-clarification',
        blocking: false,
        evidence: [
          expect.objectContaining({
            kind: 'DOCUMENT_EXCERPT',
            reference: `intake-file-extraction:${receiptId}:sha256:${textHash}`,
            summary: 'Guests should use the east entrance.',
          }),
        ],
        callbackMetadata: expect.objectContaining({
          workflow: 'intake-file-extraction-clarification',
          runId: 'run-a',
          receiptId,
          extractedTextHash: textHash,
          blockerScope: 'LOCAL',
          sourceAmendmentRequired: true,
        }),
      }),
      db,
    )
    expect(result).toMatchObject({
      questionId: 'question-a',
      sourceAmendmentRequired: true,
      blockerScope: 'LOCAL',
      blocksTerminalReview: false,
      executionTriggered: false,
      approvalGranted: false,
      packageDraftCreated: false,
      publicationTriggered: false,
      venueContactTriggered: false,
    })
  })

  it('makes only an explicit foundational ambiguity block terminal review', async () => {
    const db = {
      intakeFileExtractionReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          extractedText: 'Welcome. Guests should use the east entrance. Thank you.',
          extractedTextHash: textHash,
          review: null,
        }),
      },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
    }

    const result = await createFileExtractionClarificationQuestion(
      input(db, { blockerScope: 'FOUNDATIONAL' }),
    )

    expect(mocks.askQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        blocking: true,
        callbackMetadata: expect.objectContaining({ blockerScope: 'FOUNDATIONAL' }),
      }),
      db,
    )
    expect(result).toMatchObject({
      blockerScope: 'FOUNDATIONAL',
      blocksTerminalReview: true,
    })
  })

  it('fails closed for an excerpt outside the exact extraction or after terminal review', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      extractedText: 'Exact retained text.',
      extractedTextHash: textHash,
      review: null,
    })
    const db = {
      intakeFileExtractionReceipt: { findFirst },
      agentIdentity: { findFirst: vi.fn().mockResolvedValue({ id: 'identity-a' }) },
    }
    await expect(
      createFileExtractionClarificationQuestion(
        input(db, { evidenceExcerpt: 'Invented evidence.' }),
      ),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(mocks.askQuestion).not.toHaveBeenCalled()

    findFirst.mockResolvedValueOnce({
      extractedText: 'Guests should use the east entrance.',
      extractedTextHash: textHash,
      review: { id: 'review-a' },
    })
    await expect(createFileExtractionClarificationQuestion(input(db))).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(mocks.askQuestion).not.toHaveBeenCalled()
  })

  it('records one exact immutable source amendment without granting package authority', async () => {
    const excerpt = 'Guests should use the east entrance.'
    const answer = 'Use the accessible east entrance.'
    const resolution = {
      id: resolutionRequestId,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      receiptId,
      questionId: 'question-a',
      requestId: resolutionRequestId,
      expectedExtractedTextHash: textHash,
      answeredAt,
      kind: 'REPLACE_EXCERPT' as const,
      amendedExcerpt: answer,
      amendedExcerptHash: createHash('sha256').update(answer).digest('hex'),
      rationale: 'The founder answer supplies the missing accessible entrance detail.',
      createdBy: 'admin-a',
      fieldPath: 'knowledge.arrival',
      createdAt: new Date('2026-08-29T17:05:00.000Z'),
    }
    const findUnique = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue(resolution)
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      intakeFileClarificationResolution: { findUnique, create },
      intakeFileExtractionReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          extractedText: `Welcome. ${excerpt} Thank you.`,
          extractedTextHash: textHash,
          review: null,
        }),
      },
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-a',
          answer,
          answeredAt,
          callbackMetadata: {
            workflow: 'intake-file-extraction-clarification',
            runId: 'run-a',
            receiptId,
            extractedTextHash: textHash,
            fieldPath: 'knowledge.arrival',
            reason: 'MISSING_CONTEXT',
            blockerScope: 'FOUNDATIONAL',
            excerptHash: createHash('sha256').update(excerpt).digest('hex'),
          },
          evidence: [{ kind: 'DOCUMENT_EXCERPT', summary: excerpt }],
        }),
      },
    }
    const db = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    }
    const request = {
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      receiptId,
      requestId: resolutionRequestId,
      expectedExtractedTextHash: textHash,
      questionId: 'question-a',
      expectedAnsweredAt: answeredAt,
      kind: 'REPLACE_EXCERPT' as const,
      amendedExcerpt: answer,
      rationale: 'The founder answer supplies the missing accessible entrance detail.',
      actorId: 'admin-a',
    }

    await expect(resolveFileExtractionClarification(request as never)).resolves.toMatchObject({
      resolutionId: resolutionRequestId,
      replayed: false,
      terminalReviewRequired: true,
      packageDraftCreated: false,
      approvalGranted: false,
      canonicalVenueChanged: false,
      publicationTriggered: false,
      venueContactTriggered: false,
    })
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          questionId: 'question-a',
          answerHash: createHash('sha256').update(answer).digest('hex'),
          amendedExcerptHash: createHash('sha256').update(answer).digest('hex'),
          createdBy: 'admin-a',
        }),
      }),
    )

    findUnique.mockResolvedValueOnce(resolution)
    await expect(resolveFileExtractionClarification(request as never)).resolves.toMatchObject({
      replayed: true,
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('rejects stale answers and duplicate question amendments before mutation', async () => {
    const transaction = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      intakeFileClarificationResolution: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn(),
      },
      intakeFileExtractionReceipt: {
        findFirst: vi.fn().mockResolvedValue({
          extractedText: 'Guests should use the east entrance.',
          extractedTextHash: textHash,
          review: null,
        }),
      },
      agentQuestion: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'question-a',
          answer: 'Use the east entrance.',
          answeredAt,
          callbackMetadata: {},
          evidence: [],
        }),
      },
    }
    const db = {
      $transaction: vi.fn(async (callback: (tx: typeof transaction) => unknown) =>
        callback(transaction),
      ),
    }
    const request = {
      db,
      tenantId: 'tenant-a',
      venueId: 'venue-a',
      runId: 'run-a',
      receiptId,
      requestId: resolutionRequestId,
      expectedExtractedTextHash: textHash,
      questionId: 'question-a',
      expectedAnsweredAt: new Date('2026-08-29T17:01:00.000Z'),
      kind: 'EXCLUDE_EVIDENCE' as const,
      rationale: 'Exclude this ambiguous evidence.',
      actorId: 'admin-a',
    }

    await expect(resolveFileExtractionClarification(request as never)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('exact retained founder answer'),
    })
    expect(transaction.intakeFileClarificationResolution.create).not.toHaveBeenCalled()

    request.expectedAnsweredAt = answeredAt
    transaction.agentQuestion.findFirst.mockResolvedValueOnce({
      id: 'question-a',
      answer: 'Use the east entrance.',
      answeredAt,
      callbackMetadata: {
        workflow: 'intake-file-extraction-clarification',
        runId: 'run-a',
        receiptId,
        extractedTextHash: textHash,
        fieldPath: 'knowledge.arrival',
        reason: 'MISSING_CONTEXT',
        blockerScope: 'LOCAL',
        excerptHash: createHash('sha256')
          .update('Guests should use the east entrance.')
          .digest('hex'),
      },
      evidence: [{ kind: 'DOCUMENT_EXCERPT', summary: 'Guests should use the east entrance.' }],
    })
    transaction.intakeFileClarificationResolution.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'resolution-existing' })
    await expect(resolveFileExtractionClarification(request as never)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('already has an immutable source amendment'),
    })
    expect(transaction.intakeFileClarificationResolution.create).not.toHaveBeenCalled()
  })
})
