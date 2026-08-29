import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  IntakeFileExtractionReviewActionError,
  reviewIntakeFileExtractionAction,
} from './intake-file-extraction-review-actions'

const findReview = vi.fn()
const findReceipt = vi.fn()
const findRun = vi.fn()
const createRun = vi.fn()
const createReview = vi.fn()
const createEvidence = vi.fn()
const createEvent = vi.fn()
const createEvents = vi.fn()
const createAudit = vi.fn()
const executeRaw = vi.fn()
const findQuestion = vi.fn()
const client = {
  intakeRun: { findFirst: findRun, create: createRun },
  intakeEvidenceRecord: { create: createEvidence },
  intakeRunEvent: { create: createEvent, createMany: createEvents },
  intakeFileExtractionReceipt: { findFirst: findReceipt },
  intakeFileExtractionReview: { findUnique: findReview, create: createReview },
  agentQuestion: { findFirst: findQuestion },
  auditLog: { create: createAudit },
  $executeRaw: executeRaw,
  $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(client)),
}

const operationId = '4d8bb6f8-f1d7-42ee-944d-2a628fa50f77'
const receiptId = '975140d8-5af9-4c2d-9132-40b5cf6f5962'
const textHash = 'a'.repeat(64)
const createdAt = new Date('2026-08-29T16:55:00.000Z')

function accepted(overrides: Record<string, unknown> = {}) {
  return {
    operationId,
    tenantId: 'tenant-a',
    venueId: 'venue-a',
    sourceRunId: 'source-run-a',
    receiptId,
    expectedExtractedTextHash: textHash,
    decision: 'ACCEPTED_FOR_PROPOSAL',
    proposalTitle: 'Reviewed visitor information',
    proposalNotes: 'The east entrance is step-free.',
    rationale: 'The selected statement is clear and relevant for a later proposal review.',
    createdBy: 'admin-a',
    ...overrides,
  }
}

describe('intake file extraction review action', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    findReview.mockResolvedValue(null)
    findReceipt.mockResolvedValue({
      id: receiptId,
      sourceSha256: 'b'.repeat(64),
      sourceMimeType: 'text/plain',
      extractedTextHash: textHash,
      review: null,
    })
    findRun.mockResolvedValue(null)
    createRun.mockResolvedValue({ id: 'proposal-run-a' })
    createReview.mockResolvedValue({
      id: operationId,
      decision: 'ACCEPTED_FOR_PROPOSAL',
      proposalRunId: 'proposal-run-a',
      createdAt,
    })
    createEvidence.mockResolvedValue({ id: 'evidence-a' })
    createEvent.mockResolvedValue({ id: 'event-a' })
    createEvents.mockResolvedValue({ count: 2 })
    createAudit.mockResolvedValue({ id: 'audit-a' })
    executeRaw.mockResolvedValue(1)
    findQuestion.mockResolvedValue(null)
  })

  it('accepts exact reviewed notes into only a new awaiting-review proposal', async () => {
    const result = await reviewIntakeFileExtractionAction(accepted() as never, client as never)

    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          status: 'AWAITING_REVIEW',
          requestedByType: 'HUMAN',
          structuredBootstrap: expect.objectContaining({
            kind: 'FILE_EXTRACTION_REVIEW',
            sourceRunId: 'source-run-a',
            receiptId,
            extractedTextHash: textHash,
          }),
        }),
      }),
    )
    expect(createEvidence).toHaveBeenCalledOnce()
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: 'FILE_EXTRACTION_REVIEW_RECORDED',
          metadata: expect.objectContaining({
            proposalCreated: true,
            proposalStatus: 'AWAITING_REVIEW',
            packageDraftCreated: false,
            autoApproved: false,
            autoApplied: false,
            autoPublished: false,
            providerDispatched: false,
            contactSent: false,
          }),
        }),
      }),
    )
    expect(result).toMatchObject({
      replayed: false,
      proposalRunId: 'proposal-run-a',
      proposalCreated: true,
      proposalStatus: 'AWAITING_REVIEW',
      packageDraftCreated: false,
      autoApproved: false,
      autoApplied: false,
      autoPublished: false,
      providerDispatched: false,
      contactSent: false,
    })
  })

  it('records rejection without creating a proposal or evidence', async () => {
    createReview.mockResolvedValueOnce({
      id: operationId,
      decision: 'REJECTED',
      proposalRunId: null,
      createdAt,
    })
    const result = await reviewIntakeFileExtractionAction(
      accepted({
        decision: 'REJECTED',
        proposalTitle: undefined,
        proposalNotes: undefined,
        rationale: 'The extracted text is not venue information.',
      }) as never,
      client as never,
    )

    expect(createRun).not.toHaveBeenCalled()
    expect(createEvidence).not.toHaveBeenCalled()
    expect(createEvents).not.toHaveBeenCalled()
    expect(result).toMatchObject({ proposalCreated: false, proposalRunId: null })
    expect(findQuestion).not.toHaveBeenCalled()
  })

  it('blocks acceptance only while an exact foundational file clarification remains unresolved', async () => {
    findQuestion.mockResolvedValueOnce({ id: 'question-a' })

    await expect(
      reviewIntakeFileExtractionAction(accepted() as never, client as never),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Answer every foundational file clarification'),
    })
    expect(createRun).not.toHaveBeenCalled()
    expect(findQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          category: 'builder-file-clarification',
          blocking: true,
          status: { not: 'ANSWERED' },
          AND: [
            { callbackMetadata: { path: ['receiptId'], equals: receiptId } },
            { callbackMetadata: { path: ['runId'], equals: 'source-run-a' } },
            { callbackMetadata: { path: ['extractedTextHash'], equals: textHash } },
          ],
        }),
      }),
    )
  })

  it('continues unrelated proposal work while a local clarification remains unresolved', async () => {
    findQuestion.mockResolvedValueOnce(null)

    await expect(
      reviewIntakeFileExtractionAction(accepted() as never, client as never),
    ).resolves.toMatchObject({ proposalCreated: true, proposalRunId: 'proposal-run-a' })

    expect(findQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ blocking: true }) }),
    )
    expect(createRun).toHaveBeenCalledOnce()
  })

  it('replays only the exact terminal human decision', async () => {
    await reviewIntakeFileExtractionAction(accepted() as never, client as never)
    const stored = createReview.mock.calls[0]?.[0].data
    findReview.mockResolvedValueOnce({
      ...stored,
      id: operationId,
      proposalRunId: 'proposal-run-a',
      createdAt,
    })

    await expect(
      reviewIntakeFileExtractionAction(accepted() as never, client as never),
    ).resolves.toMatchObject({ replayed: true })
    expect(findReceipt).toHaveBeenCalledOnce()

    findReview.mockResolvedValueOnce({
      ...stored,
      id: operationId,
      proposalRunId: 'proposal-run-a',
      createdAt,
    })
    await expect(
      reviewIntakeFileExtractionAction(
        accepted({ rationale: 'Different rationale.' }) as never,
        client as never,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeFileExtractionReviewActionError>>({ code: 'CONFLICT' }),
    )
  })

  it('rejects source hash drift and an already-reviewed receipt before mutation', async () => {
    findReceipt.mockResolvedValueOnce(null)
    await expect(
      reviewIntakeFileExtractionAction(accepted() as never, client as never),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeFileExtractionReviewActionError>>({
        code: 'NOT_FOUND',
      }),
    )
    expect(createReview).not.toHaveBeenCalled()

    findReceipt.mockResolvedValueOnce({
      id: receiptId,
      sourceSha256: 'b'.repeat(64),
      sourceMimeType: 'text/plain',
      extractedTextHash: textHash,
      review: { id: 'review-existing' },
    })
    await expect(
      reviewIntakeFileExtractionAction(accepted() as never, client as never),
    ).rejects.toEqual(
      expect.objectContaining<Partial<IntakeFileExtractionReviewActionError>>({ code: 'CONFLICT' }),
    )
    expect(createReview).not.toHaveBeenCalled()
  })
})
