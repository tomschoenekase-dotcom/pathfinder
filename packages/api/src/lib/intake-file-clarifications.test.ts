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

import { createFileExtractionClarificationQuestion } from './intake-file-clarifications'

const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
const textHash = 'a'.repeat(64)

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
})
