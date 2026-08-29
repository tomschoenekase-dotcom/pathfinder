import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const reviewInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    sourceRunId: z.string().trim().min(1).max(191),
    receiptId: z.string().uuid(),
    expectedExtractedTextHash: z.string().regex(/^[a-f0-9]{64}$/u),
    decision: z.enum(['ACCEPTED_FOR_PROPOSAL', 'REJECTED']),
    proposalTitle: z.string().trim().min(1).max(255).optional(),
    proposalNotes: z.string().trim().min(1).max(20_000).optional(),
    rationale: z.string().trim().min(1).max(500),
    createdBy: z.string().trim().min(1).max(191),
  })
  .strict()
  .superRefine((value, context) => {
    const accepted = value.decision === 'ACCEPTED_FOR_PROPOSAL'
    if (accepted !== Boolean(value.proposalTitle && value.proposalNotes)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decision'],
        message: accepted
          ? 'Accepted extraction reviews require a proposal title and reviewed notes.'
          : 'Rejected extraction reviews cannot retain proposal content.',
      })
    }
  })

export type ReviewIntakeFileExtractionInput = z.infer<typeof reviewInput>

type ReviewClient = Pick<
  typeof db,
  | 'intakeRun'
  | 'intakeEvidenceRecord'
  | 'intakeRunEvent'
  | 'intakeFileExtractionReceipt'
  | 'intakeFileExtractionReview'
  | 'agentQuestion'
  | 'auditLog'
  | '$transaction'
>

export class IntakeFileExtractionReviewActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'IntakeFileExtractionReviewActionError'
  }
}

const storedReviewSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  sourceRunId: true,
  receiptId: true,
  proposalRunId: true,
  requestId: true,
  requestHash: true,
  decision: true,
  expectedExtractedTextHash: true,
  proposalTitle: true,
  proposalNotes: true,
  proposalNotesHash: true,
  rationale: true,
  createdBy: true,
  createdAt: true,
} as const

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function requestHash(input: ReviewIntakeFileExtractionInput) {
  return sha256(
    JSON.stringify({
      operationId: input.operationId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      sourceRunId: input.sourceRunId,
      receiptId: input.receiptId,
      expectedExtractedTextHash: input.expectedExtractedTextHash,
      decision: input.decision,
      proposalTitle: input.proposalTitle ?? null,
      proposalNotes: input.proposalNotes ?? null,
      rationale: input.rationale,
      createdBy: input.createdBy,
    }),
  )
}

function exactReplay(
  stored: Record<string, unknown> | null,
  input: ReviewIntakeFileExtractionInput,
  hash: string,
) {
  const notesHash = input.proposalNotes ? sha256(input.proposalNotes) : null
  return Boolean(
    stored &&
    stored.tenantId === input.tenantId &&
    stored.venueId === input.venueId &&
    stored.sourceRunId === input.sourceRunId &&
    stored.receiptId === input.receiptId &&
    stored.requestId === input.operationId &&
    stored.requestHash === hash &&
    stored.decision === input.decision &&
    stored.expectedExtractedTextHash === input.expectedExtractedTextHash &&
    stored.proposalTitle === (input.proposalTitle ?? null) &&
    stored.proposalNotes === (input.proposalNotes ?? null) &&
    stored.proposalNotesHash === notesHash &&
    stored.rationale === input.rationale &&
    stored.createdBy === input.createdBy,
  )
}

function result(
  review: { id: string; decision: string; proposalRunId: string | null; createdAt: Date },
  replayed: boolean,
) {
  return {
    reviewId: review.id,
    decision: review.decision,
    proposalRunId: review.proposalRunId,
    createdAt: review.createdAt,
    replayed,
    proposalCreated: review.proposalRunId !== null,
    proposalStatus: review.proposalRunId ? ('AWAITING_REVIEW' as const) : null,
    packageDraftCreated: false as const,
    autoApproved: false as const,
    autoApplied: false as const,
    autoPublished: false as const,
    providerDispatched: false as const,
    contactSent: false as const,
  }
}

export async function reviewIntakeFileExtractionAction(
  rawInput: ReviewIntakeFileExtractionInput,
  client: ReviewClient = db,
) {
  const parsed = reviewInput.safeParse(rawInput)
  if (!parsed.success) {
    throw new IntakeFileExtractionReviewActionError(
      'INVALID_INPUT',
      'Invalid file extraction review decision.',
    )
  }
  const input = parsed.data
  const hash = requestHash(input)
  const proposalNotesHash = input.proposalNotes ? sha256(input.proposalNotes) : null

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${input.tenantId}:${input.venueId}:${input.receiptId}`}, 0))`

    const replay = await tx.intakeFileExtractionReview.findUnique({
      where: { tenantId_requestId: { tenantId: input.tenantId, requestId: input.operationId } },
      select: storedReviewSelect,
    })
    if (replay) {
      if (!exactReplay(replay, input, hash)) {
        throw new IntakeFileExtractionReviewActionError(
          'CONFLICT',
          'The operation ID is already bound to a different extraction review.',
        )
      }
      return result(replay, true)
    }

    const receipt = await tx.intakeFileExtractionReceipt.findFirst({
      where: {
        id: input.receiptId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.sourceRunId,
        outcome: 'SUCCEEDED',
        extractedTextHash: input.expectedExtractedTextHash,
        run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
      },
      select: {
        id: true,
        sourceSha256: true,
        sourceMimeType: true,
        extractedTextHash: true,
        review: { select: { id: true } },
      },
    })
    if (!receipt) {
      throw new IntakeFileExtractionReviewActionError(
        'NOT_FOUND',
        'Successful exact file extraction receipt not found.',
      )
    }
    if (receipt.review) {
      throw new IntakeFileExtractionReviewActionError(
        'CONFLICT',
        'This extraction receipt already has a terminal human review.',
      )
    }
    if (input.decision === 'ACCEPTED_FOR_PROPOSAL') {
      const unresolvedClarification = await tx.agentQuestion.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          category: 'builder-file-clarification',
          status: { not: 'ANSWERED' },
          callbackMetadata: { path: ['receiptId'], equals: input.receiptId },
        },
        select: { id: true },
      })
      if (unresolvedClarification) {
        throw new IntakeFileExtractionReviewActionError(
          'CONFLICT',
          'Answer every retained file clarification before accepting this extraction into a proposal.',
        )
      }
    }
    const requestCollision = await tx.intakeRun.findFirst({
      where: { tenantId: input.tenantId, submissionRequestId: input.operationId },
      select: { id: true },
    })
    if (requestCollision) {
      throw new IntakeFileExtractionReviewActionError(
        'CONFLICT',
        'The operation ID is already bound to a different intake proposal.',
      )
    }

    const proposal =
      input.decision === 'ACCEPTED_FOR_PROPOSAL'
        ? await tx.intakeRun.create({
            data: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              sourceKind: 'STRUCTURED_BOOTSTRAP',
              status: 'AWAITING_REVIEW',
              displayName: input.proposalTitle!,
              structuredBootstrap: {
                kind: 'FILE_EXTRACTION_REVIEW',
                sourceRunId: input.sourceRunId,
                receiptId: input.receiptId,
                sourceSha256: receipt.sourceSha256,
                sourceMimeType: receipt.sourceMimeType,
                extractedTextHash: input.expectedExtractedTextHash,
                proposalNotes: input.proposalNotes!,
                proposalNotesHash: proposalNotesHash!,
                reviewRationale: input.rationale,
              },
              submissionRequestId: input.operationId,
              submissionInputHash: hash,
              requestedBy: input.createdBy,
              requestedByType: 'HUMAN',
            },
            select: { id: true },
          })
        : null

    const review = await tx.intakeFileExtractionReview.create({
      data: {
        id: input.operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        sourceRunId: input.sourceRunId,
        receiptId: input.receiptId,
        ...(proposal ? { proposalRunId: proposal.id } : {}),
        requestId: input.operationId,
        requestHash: hash,
        decision: input.decision,
        expectedExtractedTextHash: input.expectedExtractedTextHash,
        ...(input.proposalTitle ? { proposalTitle: input.proposalTitle } : {}),
        ...(input.proposalNotes ? { proposalNotes: input.proposalNotes } : {}),
        ...(proposalNotesHash ? { proposalNotesHash } : {}),
        rationale: input.rationale,
        createdBy: input.createdBy,
      },
      select: { id: true, decision: true, proposalRunId: true, createdAt: true },
    })

    if (proposal) {
      await tx.intakeEvidenceRecord.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: proposal.id,
          sourceKind: 'STRUCTURED_BOOTSTRAP',
          locator: `intake-file-extraction-review:${review.id}`,
          normalizedHash: proposalNotesHash!,
          confidence: 1,
          capturedAt: review.createdAt,
        },
      })
      await tx.intakeRunEvent.createMany({
        data: [
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: proposal.id,
            kind: 'PROPOSAL_CREATED',
            actorId: input.createdBy,
            metadata: {
              sourceRunId: input.sourceRunId,
              extractionReceiptId: input.receiptId,
              extractionReviewId: review.id,
              proposalNotesHash,
              status: 'AWAITING_REVIEW',
              packageDraftCreated: false,
              autoApproved: false,
              autoApplied: false,
              autoPublished: false,
            },
          },
          {
            tenantId: input.tenantId,
            venueId: input.venueId,
            runId: proposal.id,
            kind: 'EVIDENCE_RECORDED',
            actorId: input.createdBy,
            metadata: {
              extractionReviewId: review.id,
              proposalNotesHash,
            },
          },
        ],
      })
    }
    await tx.intakeRunEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.sourceRunId,
        kind: 'FILE_EXTRACTION_REVIEW_RECORDED',
        actorId: input.createdBy,
        metadata: {
          reviewId: review.id,
          receiptId: input.receiptId,
          decision: input.decision,
          expectedExtractedTextHash: input.expectedExtractedTextHash,
          proposalRunId: proposal?.id ?? null,
          proposalNotesHash,
          proposalCreated: Boolean(proposal),
          proposalStatus: proposal ? 'AWAITING_REVIEW' : null,
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
          providerDispatched: false,
          contactSent: false,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.createdBy,
        actorRole: 'PLATFORM_ADMIN',
        action: 'intake.file-extraction-reviewed',
        targetType: 'IntakeFileExtractionReview',
        targetId: review.id,
        afterState: {
          sourceRunId: input.sourceRunId,
          receiptId: input.receiptId,
          decision: input.decision,
          expectedExtractedTextHash: input.expectedExtractedTextHash,
          proposalRunId: proposal?.id ?? null,
          proposalNotesHash,
          proposalCreated: Boolean(proposal),
          proposalStatus: proposal ? 'AWAITING_REVIEW' : null,
          packageDraftCreated: false,
          autoApproved: false,
          autoApplied: false,
          autoPublished: false,
          providerDispatched: false,
          contactSent: false,
        },
      },
      tx,
    )
    return result(review, false)
  })
}
