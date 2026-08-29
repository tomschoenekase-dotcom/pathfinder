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
    `pathfinder:file-extraction-clarification:v1:${input.tenantId}:${input.venueId}:${input.runId}:${input.receiptId}:${receipt.extractedTextHash}:${input.fieldPath}:${input.reason}:${sha256(input.question)}:${excerptHash}`,
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
          'Founder/admin clarification is required for exact retained file evidence. The answer must be incorporated during the later terminal human extraction review and grants no approval, apply, publication, provider, or venue-contact authority.',
        questionType: 'LONG_TEXT',
        category: 'builder-file-clarification',
        urgency: input.reason === 'DATE_SENSITIVE' ? 'HIGH' : 'NORMAL',
        evidence: [
          {
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
          excerptHash,
          sourceAmendmentRequired: true,
        },
        blocking: true,
      },
      input.db,
    )
    return {
      questionId: result.question.id,
      questionStatus: result.question.status,
      replayed: result.replayed,
      sourceAmendmentRequired: true as const,
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
