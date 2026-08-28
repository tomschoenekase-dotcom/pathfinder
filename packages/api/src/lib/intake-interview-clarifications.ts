import { createHash } from 'node:crypto'

import {
  AgentQuestionActionError,
  IntakeActionError,
  askAgentQuestionAction,
  getIntakeProposalReview,
} from '@pathfinder/db'

import type { TRPCContext } from '../context'

type InterviewReview = Awaited<ReturnType<typeof getIntakeProposalReview>>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function deterministicUuid(value: string): string {
  const bytes = Buffer.from(createHash('sha256').update(value).digest().subarray(0, 16))
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class InterviewClarificationError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'PRECONDITION_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'InterviewClarificationError'
  }
}

export function buildInterviewClarificationReview(input: {
  tenantId: string
  venueId: string
  runId: string
  review: InterviewReview
}) {
  if (
    input.review.id !== input.runId ||
    input.review.sourceKind !== 'INTERVIEW' ||
    !input.review.consentVerified
  ) {
    throw new InterviewClarificationError(
      'PRECONDITION_FAILED',
      'Stored interview evidence cannot be projected into exact clarification evidence.',
    )
  }
  const flagged = input.review.answers
    .filter((answer) => answer.discrepancies.length > 0)
    .map((answer) => ({
      questionId: answer.questionId,
      prompt: answer.prompt,
      fieldPath: answer.fieldPath,
      privacy: answer.privacy,
      skipped: answer.skipped,
      redacted: answer.redacted,
      confidence: answer.confidence,
      evidenceId: answer.evidenceId,
      publicText: answer.publicText,
      discrepancies: [...answer.discrepancies].sort(),
    }))
    .sort(
      (left, right) =>
        left.fieldPath.localeCompare(right.fieldPath) ||
        left.questionId.localeCompare(right.questionId),
    )
  const reviewHash = sha256(
    stableJson({
      runId: input.runId,
      status: input.review.status,
      role: input.review.role,
      consentVerified: input.review.consentVerified,
      flagged,
    }),
  )
  const clarifications = flagged.map((answer) => {
    const clarificationId = `interview_clarification_${sha256(
      `${answer.questionId}:${answer.fieldPath}:${answer.discrepancies.join(':')}`,
    ).slice(0, 24)}`
    const missing = answer.discrepancies.includes('MISSING_CONTEXT')
    const preview = answer.publicText?.slice(0, 700)
    return {
      clarificationId,
      questionId: answer.questionId,
      fieldPath: answer.fieldPath,
      reasons: answer.discrepancies,
      operationId: deterministicUuid(
        `pathfinder:interview-clarification:v1:${input.tenantId}:${input.venueId}:${input.runId}:${reviewHash}:${clarificationId}`,
      ),
      question: missing
        ? `What information should Builder use for ${answer.fieldPath}?`
        : `Please confirm or correct the staff answer for ${answer.fieldPath}.`,
      context:
        'Founder/admin clarification is required for retained staff-interview evidence. The answer is guidance for a later source amendment and grants no approval, apply, publication, or venue-contact authority.',
      questionType: 'LONG_TEXT' as const,
      choices: [],
      evidence: [
        {
          label: answer.prompt,
          reference: answer.evidenceId
            ? `intake-evidence:${answer.evidenceId}`
            : `intake-run:${input.runId}:question:${answer.questionId}`,
          summary: preview
            ? `${preview}${answer.publicText && answer.publicText.length > 700 ? '…' : ''} · ${Math.round(answer.confidence * 100)}% confidence`
            : `No public answer text retained · ${answer.discrepancies.join(', ').replaceAll('_', ' ').toLowerCase()}`,
        },
      ],
      ...(answer.publicText && answer.publicText.length <= 2_000
        ? {
            proposedAnswer: {
              value: answer.publicText,
              confidence: answer.confidence,
              ...(answer.evidenceId ? { evidenceId: answer.evidenceId } : {}),
              status: 'PROPOSED_ONLY' as const,
            },
          }
        : {}),
    }
  })
  return { reviewHash, clarifications }
}

export async function loadInterviewClarificationReview(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
}) {
  try {
    const review = await getIntakeProposalReview(input)
    return buildInterviewClarificationReview({ ...input, review })
  } catch (error) {
    if (error instanceof InterviewClarificationError) throw error
    if (error instanceof IntakeActionError) {
      throw new InterviewClarificationError(
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'CONFLICT'
            ? 'CONFLICT'
            : 'INVALID_INPUT',
        error.message,
      )
    }
    throw error
  }
}

export async function createInterviewClarificationQuestions(input: {
  db: TRPCContext['db']
  tenantId: string
  venueId: string
  runId: string
  expectedReviewHash: string
  clarificationIds: readonly string[]
  agentIdentityId: string
}) {
  const review = await loadInterviewClarificationReview(input)
  if (review.reviewHash !== input.expectedReviewHash) {
    throw new InterviewClarificationError(
      'CONFLICT',
      'Interview evidence changed; reload Builder before creating questions.',
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
    throw new InterviewClarificationError(
      'PRECONDITION_FAILED',
      'Choose an enabled in-scope Content identity with draft capability.',
    )
  }
  const selected = new Set(input.clarificationIds)
  const clarifications = review.clarifications.filter(({ clarificationId }) =>
    selected.has(clarificationId),
  )
  if (clarifications.length !== selected.size) {
    throw new InterviewClarificationError(
      'INVALID_INPUT',
      'Every selected clarification must exist in the exact retained interview evidence.',
    )
  }

  try {
    const questions = []
    for (const clarification of clarifications) {
      const result = await askAgentQuestionAction(
        {
          operationId: clarification.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: identity.id,
          question: clarification.question,
          context: clarification.context,
          questionType: clarification.questionType,
          category: 'builder-interview-clarification',
          urgency: 'NORMAL',
          choices: clarification.choices,
          evidence: clarification.evidence,
          ...('proposedAnswer' in clarification
            ? { proposedAnswer: clarification.proposedAnswer }
            : {}),
          callbackMetadata: {
            workflow: 'intake-interview-clarification',
            runId: input.runId,
            reviewHash: review.reviewHash,
            clarificationId: clarification.clarificationId,
            questionId: clarification.questionId,
            fieldPath: clarification.fieldPath,
            reasons: clarification.reasons.join(','),
          },
          blocking: true,
        },
        input.db,
      )
      questions.push({
        clarificationId: clarification.clarificationId,
        questionId: result.question.id,
        status: result.question.status,
        replayed: result.replayed,
      })
    }
    return {
      reviewHash: review.reviewHash,
      questions,
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
      throw new InterviewClarificationError(
        error.code === 'CONFLICT' ? 'CONFLICT' : 'PRECONDITION_FAILED',
        error.message,
      )
    }
    throw error
  }
}
