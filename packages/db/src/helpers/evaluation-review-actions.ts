import { createHash } from 'node:crypto'

import type { EvalReviewDecision } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HASH_PATTERN = /^[0-9a-f]{64}$/u
const RUBRIC_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u

export type EvaluationReviewActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type EvaluationReviewActionClient = Pick<typeof db, '$transaction'>
type EvaluationReviewTransaction = Pick<typeof db, 'evalReview' | 'evalResult' | 'auditLog'>

export class EvaluationReviewActionError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'EvaluationReviewActionError'
  }
}

export type AppendEvaluationReviewInput = {
  tenantId: string
  venueId: string
  runId: string
  expectedRunIdentityHash: string
  resultId: string
  expectedRevision: number
  operationId: string
  decision: EvalReviewDecision
  conclusion: string
  rubricVersion: string
  actor: EvaluationReviewActor
}

function invalid(message: string): never {
  throw new EvaluationReviewActionError('INVALID_INPUT', message)
}

function normalize(input: AppendEvaluationReviewInput) {
  if (!input.tenantId.trim() || !input.venueId.trim())
    invalid('Exact tenant and venue scope is required.')
  if (!UUID_PATTERN.test(input.runId) || !UUID_PATTERN.test(input.resultId))
    invalid('Run and result IDs must be UUIDs.')
  if (!UUID_PATTERN.test(input.operationId)) invalid('Operation ID must be a UUID.')
  if (!HASH_PATTERN.test(input.expectedRunIdentityHash))
    invalid('Expected run identity must be a lowercase SHA-256 digest.')
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0)
    invalid('Expected review revision must be a nonnegative integer.')
  if (
    input.actor.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  )
    invalid('A human platform administrator is required.')
  if (!['ACCEPTED', 'REJECTED', 'NEEDS_FOLLOW_UP'].includes(input.decision))
    invalid('Review decision is invalid.')
  const conclusion = input.conclusion.trim()
  if (!conclusion || conclusion.length > 1000) invalid('Conclusion must be 1 to 1000 characters.')
  const rubricVersion = input.rubricVersion.trim()
  if (!RUBRIC_PATTERN.test(rubricVersion)) invalid('Rubric version is invalid.')
  return { ...input, conclusion, rubricVersion }
}

export function evaluationReviewInputHash(input: ReturnType<typeof normalize>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'pathfinder-evaluation-review-command-v1',
        input.tenantId,
        input.venueId,
        input.runId,
        input.expectedRunIdentityHash,
        input.resultId,
        input.expectedRevision,
        input.operationId,
        input.decision,
        input.conclusion,
        input.rubricVersion,
        input.actor.type,
        input.actor.id,
        input.actor.role,
      ]),
      'utf8',
    )
    .digest('hex')
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

const reviewSelect = {
  id: true,
  resultId: true,
  reviewerId: true,
  conclusion: true,
  decision: true,
  rubricVersion: true,
  revision: true,
  submissionOperationId: true,
  submissionInputHash: true,
  createdAt: true,
  result: {
    select: {
      runId: true,
      caseRevision: true,
      run: { select: { identityHash: true } },
      evalCase: { select: { caseKey: true, category: true } },
    },
  },
} as const

function assertReplay(
  review: Awaited<ReturnType<typeof findReplay>>,
  input: ReturnType<typeof normalize>,
  inputHash: string,
) {
  if (!review) return null
  if (
    review.submissionInputHash !== inputHash ||
    review.reviewerId !== input.actor.id ||
    review.resultId !== input.resultId ||
    review.result.runId !== input.runId ||
    review.result.run.identityHash !== input.expectedRunIdentityHash ||
    review.revision !== input.expectedRevision + 1
  )
    throw new EvaluationReviewActionError(
      'CONFLICT',
      'Evaluation review operation ID was already used for different evidence.',
    )
  return { ...review, replayed: true as const }
}

async function findReplay(tx: EvaluationReviewTransaction, tenantId: string, operationId: string) {
  return tx.evalReview.findFirst({
    where: { tenantId, submissionOperationId: operationId },
    select: reviewSelect,
  })
}

export async function appendEvaluationReviewAction(
  rawInput: AppendEvaluationReviewInput,
  client: EvaluationReviewActionClient = db,
) {
  const input = normalize(rawInput)
  const inputHash = evaluationReviewInputHash(input)

  const attempt = () =>
    client.$transaction(async (tx) => {
      const replay = assertReplay(
        await findReplay(tx, input.tenantId, input.operationId),
        input,
        inputHash,
      )
      if (replay) return replay

      const result = await tx.evalResult.findFirst({
        where: {
          id: input.resultId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          runId: input.runId,
          run: { identityHash: input.expectedRunIdentityHash, status: 'COMPLETED' },
        },
        select: {
          id: true,
          runId: true,
          run: { select: { identityHash: true } },
          evalCase: { select: { caseKey: true, category: true } },
          reviews: { orderBy: { revision: 'desc' }, take: 1, select: { revision: true } },
        },
      })
      if (!result)
        throw new EvaluationReviewActionError('NOT_FOUND', 'Evaluation result was not found.')
      const currentRevision = result.reviews[0]?.revision ?? 0
      if (currentRevision !== input.expectedRevision)
        throw new EvaluationReviewActionError(
          'CONFLICT',
          'Evaluation conclusion changed; refresh before appending another revision.',
        )

      const created = await tx.evalReview.create({
        data: {
          id: input.operationId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          resultId: input.resultId,
          reviewerId: input.actor.id,
          conclusion: input.conclusion,
          decision: input.decision,
          rubricVersion: input.rubricVersion,
          revision: currentRevision + 1,
          submissionOperationId: input.operationId,
          submissionInputHash: inputHash,
        },
        select: reviewSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'evaluation.review-conclusion-appended',
          targetType: 'EvalReview',
          targetId: created.id,
          afterState: {
            venueId: input.venueId,
            runId: input.runId,
            resultId: input.resultId,
            caseKey: result.evalCase.caseKey,
            category: result.evalCase.category,
            decision: input.decision,
            rubricVersion: input.rubricVersion,
            revision: created.revision,
            conclusionLength: input.conclusion.length,
          },
        },
        tx,
      )
      return { ...created, replayed: false as const }
    })

  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    return client.$transaction(async (tx) => {
      const replay = assertReplay(
        await findReplay(tx, input.tenantId, input.operationId),
        input,
        inputHash,
      )
      if (replay) return replay
      throw new EvaluationReviewActionError(
        'CONFLICT',
        'Evaluation conclusion changed concurrently; refresh before retrying.',
      )
    })
  }
}
