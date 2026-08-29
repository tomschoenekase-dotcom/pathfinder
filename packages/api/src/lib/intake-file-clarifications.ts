import { createHash } from 'node:crypto'

import { AgentQuestionActionError, askAgentQuestionAction } from '@pathfinder/db'

import type { TRPCContext } from '../context'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export const FILE_CLARIFICATION_REASONS = [
  'CONTRADICTION',
  'DATE_SENSITIVE',
  'LOW_CONFIDENCE',
  'MISSING_CONTEXT',
] as const

export const FILE_CLARIFICATION_BLOCKER_SCOPES = ['LOCAL', 'FOUNDATIONAL'] as const

export class FileClarificationError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'FileClarificationError'
  }
}

export async function createFileExtractionClarificationQuestion(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  expectedExtractedTextHash: string
  fieldPath: string
  reason: (typeof FILE_CLARIFICATION_REASONS)[number]
  blockerScope: (typeof FILE_CLARIFICATION_BLOCKER_SCOPES)[number]
  question: string
  evidenceExcerpt: string
  agentIdentityId: string
}) {
  const receipt = await input.db.intakeFileExtractionReceipt.findFirst({
    where: {
      id: input.receiptId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      runId: input.runId,
      outcome: 'SUCCEEDED',
      extractedTextHash: input.expectedExtractedTextHash,
      run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
    },
    select: {
      extractedText: true,
      extractedTextHash: true,
      review: { select: { id: true } },
    },
  })
  if (!receipt?.extractedText || !receipt.extractedTextHash) {
    throw new FileClarificationError('NOT_FOUND', 'Successful exact file extraction not found.')
  }
  if (receipt.review) {
    throw new FileClarificationError(
      'CONFLICT',
      'The terminal extraction review is already recorded; no new clarification can be attached.',
    )
  }
  if (!receipt.extractedText.includes(input.evidenceExcerpt)) {
    throw new FileClarificationError(
      'PRECONDITION_FAILED',
      'The evidence excerpt must match the exact retained extraction text.',
    )
  }
  const identity = await input.db.agentIdentity.findFirst({
    where: {
      id: input.agentIdentityId,
      tenantId: input.tenantId,
      enabled: true,
      agentType: 'CONTENT',
      accessCapabilities: { has: 'content.draft' },
      OR: [{ venueId: input.venueId }, { venueId: null, accessScope: 'CLIENT' }],
    },
    select: { id: true },
  })
  if (!identity) {
    throw new FileClarificationError(
      'PRECONDITION_FAILED',
      'Choose an enabled in-scope Content identity with draft capability.',
    )
  }
  const excerptHash = sha256(input.evidenceExcerpt)
  const operationId = deterministicUuid(
    `pathfinder:file-extraction-clarification:v3:${input.tenantId}:${input.venueId}:${input.runId}:${input.receiptId}:${receipt.extractedTextHash}:${input.fieldPath}:${input.reason}:${input.blockerScope}:${sha256(input.question)}:${excerptHash}`,
  )

  try {
    const result = await askAgentQuestionAction(
      {
        operationId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentIdentityId: identity.id,
        question: input.question,
        context:
          input.blockerScope === 'FOUNDATIONAL'
            ? 'Founder/admin clarification is required for exact retained file evidence. This foundational uncertainty blocks terminal acceptance until answered. The answer must be incorporated during the later terminal human extraction review and grants no approval, apply, publication, provider, or venue-contact authority.'
            : 'Founder/admin clarification is required for exact retained file evidence. This local uncertainty blocks only the affected field/topic; unrelated reviewed proposal work may continue while the ticket remains visible. Its evidence must be excluded until answered, and the answer grants no approval, apply, publication, provider, or venue-contact authority.',
        questionType: 'LONG_TEXT',
        category: 'builder-file-clarification',
        urgency: input.reason === 'DATE_SENSITIVE' ? 'HIGH' : 'NORMAL',
        evidence: [
          {
            kind: 'DOCUMENT_EXCERPT',
            label: `${input.fieldPath} (${input.reason.replaceAll('_', ' ').toLowerCase()})`,
            reference: `intake-file-extraction:${input.receiptId}:sha256:${receipt.extractedTextHash}`,
            summary: input.evidenceExcerpt,
          },
        ],
        callbackMetadata: {
          workflow: 'intake-file-extraction-clarification',
          runId: input.runId,
          receiptId: input.receiptId,
          extractedTextHash: receipt.extractedTextHash,
          fieldPath: input.fieldPath,
          reason: input.reason,
          blockerScope: input.blockerScope,
          excerptHash,
          sourceAmendmentRequired: true,
        },
        blocking: input.blockerScope === 'FOUNDATIONAL',
      },
      input.db,
    )
    return {
      questionId: result.question.id,
      questionStatus: result.question.status,
      replayed: result.replayed,
      sourceAmendmentRequired: true as const,
      blockerScope: input.blockerScope,
      blocksTerminalReview: input.blockerScope === 'FOUNDATIONAL',
      executionTriggered: false as const,
      approvalGranted: false as const,
      canonicalVenueChanged: false as const,
      packageDraftCreated: false as const,
      publicationTriggered: false as const,
      venueContactTriggered: false as const,
    }
  } catch (error) {
    if (error instanceof AgentQuestionActionError) {
      throw new FileClarificationError(
        error.code === 'CONFLICT' ? 'CONFLICT' : 'PRECONDITION_FAILED',
        error.message,
      )
    }
    throw error
  }
}

export async function resolveFileExtractionClarification(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  receiptId: string
  requestId: string
  expectedExtractedTextHash: string
  questionId: string
  expectedAnsweredAt: Date
  kind: 'REPLACE_EXCERPT' | 'EXCLUDE_EVIDENCE'
  amendedExcerpt?: string
  rationale: string
  actorId: string
}) {
  const amendedExcerpt = input.amendedExcerpt?.trim()
  if (
    (input.kind === 'REPLACE_EXCERPT' && !amendedExcerpt) ||
    (input.kind === 'EXCLUDE_EVIDENCE' && amendedExcerpt !== undefined)
  ) {
    throw new FileClarificationError(
      'INVALID_INPUT',
      input.kind === 'REPLACE_EXCERPT'
        ? 'Replacement resolution requires an amended excerpt.'
        : 'Evidence exclusion cannot carry an amended excerpt.',
    )
  }

  return input.db.$transaction(async (transaction) => {
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:intake-file-extraction-review:${input.tenantId}:${input.venueId}:${input.receiptId}`}, 0))`

    const priorRequest = await transaction.intakeFileClarificationResolution.findUnique({
      where: {
        tenantId_requestId: { tenantId: input.tenantId, requestId: input.requestId },
      },
    })
    if (priorRequest) {
      const replayed =
        priorRequest.tenantId === input.tenantId &&
        priorRequest.venueId === input.venueId &&
        priorRequest.runId === input.runId &&
        priorRequest.receiptId === input.receiptId &&
        priorRequest.questionId === input.questionId &&
        priorRequest.expectedExtractedTextHash === input.expectedExtractedTextHash &&
        priorRequest.answeredAt.getTime() === input.expectedAnsweredAt.getTime() &&
        priorRequest.kind === input.kind &&
        priorRequest.amendedExcerpt === (amendedExcerpt ?? null) &&
        priorRequest.amendedExcerptHash === (amendedExcerpt ? sha256(amendedExcerpt) : null) &&
        priorRequest.rationale === input.rationale.trim() &&
        priorRequest.createdBy === input.actorId
      if (!replayed) {
        throw new FileClarificationError(
          'CONFLICT',
          'The request ID is already bound to a different file amendment.',
        )
      }
      return fileResolutionResult(priorRequest, true)
    }

    const receipt = await transaction.intakeFileExtractionReceipt.findFirst({
      where: {
        id: input.receiptId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        outcome: 'SUCCEEDED',
        extractedTextHash: input.expectedExtractedTextHash,
        run: { sourceKind: 'FILE_UPLOAD', status: 'AWAITING_REVIEW' },
      },
      select: {
        extractedText: true,
        extractedTextHash: true,
        review: { select: { id: true } },
      },
    })
    if (!receipt?.extractedText || !receipt.extractedTextHash) {
      throw new FileClarificationError('NOT_FOUND', 'Successful exact file extraction not found.')
    }
    if (receipt.review) {
      throw new FileClarificationError(
        'CONFLICT',
        'The terminal extraction review is already recorded; no source amendment can be attached.',
      )
    }

    const question = await transaction.agentQuestion.findFirst({
      where: {
        id: input.questionId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        category: 'builder-file-clarification',
        status: 'ANSWERED',
      },
      select: {
        id: true,
        answer: true,
        answeredAt: true,
        callbackMetadata: true,
        evidence: true,
      },
    })
    if (
      !question?.answer ||
      !question.answeredAt ||
      question.answeredAt.getTime() !== input.expectedAnsweredAt.getTime()
    ) {
      throw new FileClarificationError(
        'PRECONDITION_FAILED',
        'An exact retained founder answer is required before source amendment.',
      )
    }
    const metadata =
      question.callbackMetadata &&
      typeof question.callbackMetadata === 'object' &&
      !Array.isArray(question.callbackMetadata)
        ? (question.callbackMetadata as Record<string, unknown>)
        : {}
    const evidence = Array.isArray(question.evidence) ? question.evidence : []
    const excerpt = evidence.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return []
      const record = item as Record<string, unknown>
      return record.kind === 'DOCUMENT_EXCERPT' && typeof record.summary === 'string'
        ? [record.summary]
        : []
    })[0]
    const fieldPath = metadata.fieldPath
    const reason = metadata.reason
    const blockerScope = metadata.blockerScope
    const excerptHash = metadata.excerptHash
    if (
      metadata.workflow !== 'intake-file-extraction-clarification' ||
      metadata.runId !== input.runId ||
      metadata.receiptId !== input.receiptId ||
      metadata.extractedTextHash !== input.expectedExtractedTextHash ||
      typeof fieldPath !== 'string' ||
      !(FILE_CLARIFICATION_REASONS as readonly unknown[]).includes(reason) ||
      !(FILE_CLARIFICATION_BLOCKER_SCOPES as readonly unknown[]).includes(blockerScope) ||
      typeof excerptHash !== 'string' ||
      typeof excerpt !== 'string' ||
      sha256(excerpt) !== excerptHash ||
      !receipt.extractedText.includes(excerpt)
    ) {
      throw new FileClarificationError(
        'PRECONDITION_FAILED',
        'The retained clarification no longer matches the exact extraction evidence.',
      )
    }

    const existingQuestionResolution =
      await transaction.intakeFileClarificationResolution.findUnique({
        where: { questionId: question.id },
      })
    if (existingQuestionResolution) {
      throw new FileClarificationError(
        'CONFLICT',
        'This answered clarification already has an immutable source amendment.',
      )
    }
    const resolution = await transaction.intakeFileClarificationResolution.create({
      data: {
        id: input.requestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: input.runId,
        receiptId: input.receiptId,
        questionId: question.id,
        requestId: input.requestId,
        expectedExtractedTextHash: input.expectedExtractedTextHash,
        fieldPath,
        reason: reason as (typeof FILE_CLARIFICATION_REASONS)[number],
        blockerScope: blockerScope as (typeof FILE_CLARIFICATION_BLOCKER_SCOPES)[number],
        excerptHash,
        answerHash: sha256(question.answer),
        answeredAt: question.answeredAt,
        kind: input.kind,
        amendedExcerpt: amendedExcerpt ?? null,
        amendedExcerptHash: amendedExcerpt ? sha256(amendedExcerpt) : null,
        rationale: input.rationale.trim(),
        createdBy: input.actorId,
      },
    })
    return fileResolutionResult(resolution, false)
  })
}

function fileResolutionResult(
  resolution: {
    id: string
    questionId: string
    receiptId: string
    fieldPath: string
    kind: 'REPLACE_EXCERPT' | 'EXCLUDE_EVIDENCE'
    createdAt: Date
  },
  replayed: boolean,
) {
  return {
    resolutionId: resolution.id,
    questionId: resolution.questionId,
    receiptId: resolution.receiptId,
    fieldPath: resolution.fieldPath,
    kind: resolution.kind,
    createdAt: resolution.createdAt,
    replayed,
    terminalReviewRequired: true as const,
    packageDraftCreated: false as const,
    approvalGranted: false as const,
    canonicalVenueChanged: false as const,
    publicationTriggered: false as const,
    venueContactTriggered: false as const,
  }
}
