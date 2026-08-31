import { createHash } from 'node:crypto'

import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'
import {
  GuestAnswerEvidenceBundleSchema,
  type GuestAnswerAttribution,
} from '@pathfinder/contracts/guest-answer-attribution'
import { createVerifiedGuestAnswerAttribution } from '@pathfinder/contracts/guest-answer-attribution-node'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export const GUEST_ANSWER_ATTRIBUTION_EVALUATION_LEASE_MS = 5 * 60 * 1_000
export const GUEST_ANSWER_ATTRIBUTION_EVALUATOR_ACTOR_ID = 'guest-answer-attribution-evaluator-v1'

export type GuestAnswerAttributionEvaluationActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type GuestAnswerAttributionEvaluationErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'

export const GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILURE_CODES = [
  'REQUEST_BUDGET_CEILING_EXCEEDED',
  'CAPABILITY_MISMATCH',
  'CAPABILITY_NOT_ENTITLED',
  'CAPABILITY_UNAVAILABLE',
  'NO_HEALTHY_ROUTE',
  'PROVIDER_CONFIGURATION_REQUIRED',
  'PROVIDER_CONNECTION_FAILED',
  'PROVIDER_REQUEST_ABORTED',
  'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_REQUEST_FAILED',
  'GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILED',
  'WORKER_LOST_AFTER_PROVIDER_DISPATCH',
] as const

export type GuestAnswerAttributionEvaluationFailureCode =
  (typeof GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILURE_CODES)[number]

const guestAnswerAttributionEvaluationFailureCodes = new Set<string>(
  GUEST_ANSWER_ATTRIBUTION_EVALUATION_FAILURE_CODES,
)

export class GuestAnswerAttributionEvaluationError extends Error {
  constructor(
    readonly code: GuestAnswerAttributionEvaluationErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuestAnswerAttributionEvaluationError'
  }
}

type EvaluationClient = Pick<typeof db, '$transaction' | 'guestAnswerAttributionEvaluationRequest'>

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
function fail(code: GuestAnswerAttributionEvaluationErrorCode, message: string): never {
  throw new GuestAnswerAttributionEvaluationError(code, message)
}

function digest(value: CanonicalJsonValue): string {
  return createHash('sha256').update(canonicalEvaluationJson(value)).digest('hex')
}

function requireScope(input: {
  tenantId: string
  venueId: string
  actor?: GuestAnswerAttributionEvaluationActor
}) {
  if (
    !input.tenantId?.trim() ||
    !input.venueId?.trim() ||
    (input.actor &&
      (input.actor.type !== 'HUMAN' ||
        input.actor.role !== 'PLATFORM_ADMIN' ||
        !input.actor.id?.trim()))
  ) {
    fail('INVALID_INPUT', 'Exact scope and a human platform administrator are required')
  }
}

const requestSelect = {
  id: true,
  operationId: true,
  inputHash: true,
  tenantId: true,
  venueId: true,
  sessionId: true,
  guestChatTurnId: true,
  answerHash: true,
  evidenceSetHash: true,
  status: true,
  attemptNumber: true,
  leaseToken: true,
  leaseExpiresAt: true,
  providerDispatchedAt: true,
  resultAttributionId: true,
  lastErrorCode: true,
  createdById: true,
  queuedAt: true,
  startedAt: true,
  completedAt: true,
  failedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

async function loadExactTurn(
  tx: typeof db,
  input: { tenantId: string; venueId: string; guestChatTurnId: string },
) {
  const turn = await tx.guestChatTurn.findFirst({
    where: {
      id: input.guestChatTurnId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'COMPLETE',
      session: { experienceScope: 'PUBLIC' },
    },
    select: {
      id: true,
      sessionId: true,
      replayMetadata: true,
      assistantMessage: { select: { content: true } },
    },
  })
  if (!turn?.assistantMessage) fail('NOT_FOUND', 'Completed public guest answer was not found')
  const replay =
    typeof turn.replayMetadata === 'object' && turn.replayMetadata !== null
      ? (turn.replayMetadata as Record<string, unknown>)
      : null
  const evidence = GuestAnswerEvidenceBundleSchema.safeParse(replay?.answerEvidence)
  if (!evidence.success) {
    fail(
      'PRECONDITION_FAILED',
      'This answer predates exact attribution evidence and cannot be evaluated safely',
    )
  }
  return { turn, answer: turn.assistantMessage.content, evidence: evidence.data }
}

export async function prepareGuestAnswerAttributionEvaluationRequestAction(
  input: {
    operationId: string
    tenantId: string
    venueId: string
    guestChatTurnId: string
    actor: GuestAnswerAttributionEvaluationActor
  },
  client: EvaluationClient = db,
) {
  requireScope(input)
  if (!uuid.test(input.operationId) || !uuid.test(input.guestChatTurnId)) {
    fail('INVALID_INPUT', 'Exact UUID operation and guest-turn identities are required')
  }
  const inputHash = digest({
    version: 'guest-answer-attribution-evaluation-request-v1',
    tenantId: input.tenantId,
    venueId: input.venueId,
    guestChatTurnId: input.guestChatTurnId,
    actor: input.actor,
  })

  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const existing = await tx.guestAnswerAttributionEvaluationRequest.findFirst({
      where: { tenantId: input.tenantId, operationId: input.operationId },
      select: requestSelect,
    })
    if (existing) {
      if (existing.inputHash !== inputHash) {
        fail('CONFLICT', 'Operation ID was already used for a different evaluation request')
      }
      return { request: existing, replayed: true as const }
    }

    const { turn, answer, evidence } = await loadExactTurn(tx, input)
    // Empty claims validate every frozen hash without making a semantic judgment.
    createVerifiedGuestAnswerAttribution({
      answer,
      evidence,
      evaluator: {
        provider: 'preflight',
        model: 'integrity-check',
        configurationVersion: 'integrity-check-v1',
        promptVersion: 'guest-answer-attribution-evaluator-v1',
      },
      claims: [],
    })
    const request = await tx.guestAnswerAttributionEvaluationRequest.create({
      data: {
        operationId: input.operationId,
        inputHash,
        tenantId: input.tenantId,
        venueId: input.venueId,
        sessionId: turn.sessionId,
        guestChatTurnId: turn.id,
        answerHash: evidence.answerHash,
        evidenceSetHash: evidence.evidenceSetHash,
        createdById: input.actor.id,
      },
      select: requestSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'guest-answer-attribution-evaluation.staged',
        targetType: 'GuestAnswerAttributionEvaluationRequest',
        targetId: request.id,
        sourceReferences: [`guest-chat-turn:${turn.id}`],
        afterState: {
          venueId: input.venueId,
          guestChatTurnId: turn.id,
          answerHash: evidence.answerHash,
          evidenceSetHash: evidence.evidenceSetHash,
          status: request.status,
        },
      },
      tx,
    )
    return { request, replayed: false as const }
  })
}

export async function queueGuestAnswerAttributionEvaluationRequestAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    actor: GuestAnswerAttributionEvaluationActor
  },
  client: EvaluationClient = db,
) {
  requireScope(input)
  if (!uuid.test(input.requestId)) fail('INVALID_INPUT', 'Exact request identity is required')
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const request = await tx.guestAnswerAttributionEvaluationRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: requestSelect,
    })
    if (!request) fail('NOT_FOUND', 'Evaluation request was not found')
    if (request.status === 'QUEUED') return { request, replayed: true as const }
    if (request.status !== 'STAGED') {
      fail('PRECONDITION_FAILED', `Evaluation request is already ${request.status.toLowerCase()}`)
    }
    const now = new Date()
    const changed = await tx.guestAnswerAttributionEvaluationRequest.updateMany({
      where: { id: request.id, tenantId: input.tenantId, venueId: input.venueId, status: 'STAGED' },
      data: { status: 'QUEUED', queuedAt: now },
    })
    if (changed.count !== 1) fail('CONFLICT', 'Evaluation request changed while it was queued')
    const queued = await tx.guestAnswerAttributionEvaluationRequest.findUniqueOrThrow({
      where: { id: request.id },
      select: requestSelect,
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'guest-answer-attribution-evaluation.queued',
        targetType: 'GuestAnswerAttributionEvaluationRequest',
        targetId: request.id,
        sourceReferences: [`guest-chat-turn:${request.guestChatTurnId}`],
        afterState: { venueId: input.venueId, status: queued.status },
      },
      tx,
    )
    return { request: queued, replayed: false as const }
  })
}

export async function claimGuestAnswerAttributionEvaluationRequestAction(
  input: { tenantId: string; venueId: string; requestId: string; leaseToken: string; now?: Date },
  client: EvaluationClient = db,
) {
  requireScope(input)
  if (!uuid.test(input.requestId) || !uuid.test(input.leaseToken)) {
    fail('INVALID_INPUT', 'Exact request and lease identities are required')
  }
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const changed = await tx.guestAnswerAttributionEvaluationRequest.updateMany({
      where: {
        id: input.requestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'QUEUED',
        providerDispatchedAt: null,
      },
      data: {
        status: 'RUNNING',
        attemptNumber: { increment: 1 },
        leaseToken: input.leaseToken,
        leaseExpiresAt: new Date(now.getTime() + GUEST_ANSWER_ATTRIBUTION_EVALUATION_LEASE_MS),
        startedAt: now,
      },
    })
    if (changed.count !== 1) {
      const existing = await tx.guestAnswerAttributionEvaluationRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: requestSelect,
      })
      if (!existing) fail('NOT_FOUND', 'Evaluation request was not found')
      return { state: 'not-claimed' as const, request: existing }
    }
    const request = await tx.guestAnswerAttributionEvaluationRequest.findUniqueOrThrow({
      where: { id: input.requestId },
      select: requestSelect,
    })
    const exact = await loadExactTurn(tx, request)
    if (
      exact.evidence.answerHash !== request.answerHash ||
      exact.evidence.evidenceSetHash !== request.evidenceSetHash
    ) {
      fail('PRECONDITION_FAILED', 'Frozen answer evidence no longer matches the request identity')
    }
    return { state: 'claimed' as const, request, answer: exact.answer, evidence: exact.evidence }
  })
}

export async function markGuestAnswerAttributionEvaluationDispatchedAction(
  input: { tenantId: string; venueId: string; requestId: string; leaseToken: string; now?: Date },
  client: EvaluationClient = db,
) {
  const now = input.now ?? new Date()
  const changed = await client.guestAnswerAttributionEvaluationRequest.updateMany({
    where: {
      id: input.requestId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'RUNNING',
      leaseToken: input.leaseToken,
      leaseExpiresAt: { gt: now },
      providerDispatchedAt: null,
    },
    data: { providerDispatchedAt: now },
  })
  if (changed.count !== 1) fail('CONFLICT', 'Evaluation dispatch fence was not acquired')
}

export async function completeGuestAnswerAttributionEvaluationRequestAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    leaseToken: string
    attribution: GuestAnswerAttribution
    now?: Date
  },
  client: EvaluationClient = db,
) {
  if (!uuid.test(input.requestId) || !uuid.test(input.leaseToken)) {
    fail('INVALID_INPUT', 'Exact request and lease identities are required')
  }
  const now = input.now ?? new Date()
  return client.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as typeof db
    const request = await tx.guestAnswerAttributionEvaluationRequest.findFirst({
      where: {
        id: input.requestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'RUNNING',
        leaseToken: input.leaseToken,
        leaseExpiresAt: { gt: now },
        providerDispatchedAt: { not: null },
      },
      select: requestSelect,
    })
    if (!request) fail('CONFLICT', 'Evaluation request lease or dispatch evidence is invalid')
    const exact = await loadExactTurn(tx, request)
    const verified = createVerifiedGuestAnswerAttribution({
      answer: exact.answer,
      evidence: exact.evidence,
      evaluator: input.attribution.evaluator,
      claims: input.attribution.claims,
    })
    if (
      verified.answerHash !== request.answerHash ||
      verified.evidenceSetHash !== request.evidenceSetHash
    ) {
      fail('CONFLICT', 'Evaluator result does not match the frozen request identity')
    }
    const attributionInputHash = digest({
      version: 'guest-answer-attribution-evaluation-result-v1',
      requestId: request.id,
      attribution: verified as unknown as CanonicalJsonValue,
    })
    const attribution = await tx.guestAnswerAttribution.create({
      data: {
        operationId: request.id,
        inputHash: attributionInputHash,
        tenantId: request.tenantId,
        venueId: request.venueId,
        sessionId: request.sessionId,
        guestChatTurnId: request.guestChatTurnId,
        schemaVersion: verified.schemaVersion,
        answerHash: verified.answerHash,
        evidenceSetHash: verified.evidenceSetHash,
        evaluatorProvider: verified.evaluator.provider,
        evaluatorModel: verified.evaluator.model,
        evaluatorConfiguration: verified.evaluator.configurationVersion,
        evaluatorPromptVersion: verified.evaluator.promptVersion,
        attributionSnapshot: JSON.parse(JSON.stringify(verified)),
        claimCount: verified.metrics.claimCount,
        supportedCount: verified.metrics.supportedCount,
        unsupportedCount: verified.metrics.unsupportedCount,
        uncertainCount: verified.metrics.uncertainCount,
        nonFactualCount: verified.metrics.nonFactualCount,
        supportRate: verified.metrics.supportRate,
        actorType: 'SYSTEM',
        actorId: GUEST_ANSWER_ATTRIBUTION_EVALUATOR_ACTOR_ID,
      },
      select: { id: true, attributionSnapshot: true, actorType: true, actorId: true },
    })
    const changed = await tx.guestAnswerAttributionEvaluationRequest.updateMany({
      where: { id: request.id, status: 'RUNNING', leaseToken: input.leaseToken },
      data: {
        status: 'COMPLETED',
        resultAttributionId: attribution.id,
        completedAt: now,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    })
    if (changed.count !== 1) fail('CONFLICT', 'Evaluation request changed before completion')
    await writeAuditLogStrict(
      {
        tenantId: request.tenantId,
        actorId: GUEST_ANSWER_ATTRIBUTION_EVALUATOR_ACTOR_ID,
        actorRole: 'SYSTEM',
        action: 'guest-answer-attribution-evaluation.completed',
        targetType: 'GuestAnswerAttributionEvaluationRequest',
        targetId: request.id,
        sourceReferences: [
          `guest-chat-turn:${request.guestChatTurnId}`,
          `guest-answer-attribution:${attribution.id}`,
        ],
        afterState: {
          venueId: request.venueId,
          status: 'COMPLETED',
          answerHash: request.answerHash,
          evidenceSetHash: request.evidenceSetHash,
          evaluator: verified.evaluator,
          metrics: verified.metrics,
        },
      },
      tx,
    )
    return { requestId: request.id, attribution }
  })
}

export async function failGuestAnswerAttributionEvaluationRequestAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    leaseToken: string
    errorCode: GuestAnswerAttributionEvaluationFailureCode
    ambiguous?: boolean
    now?: Date
  },
  client: EvaluationClient = db,
) {
  if (
    !uuid.test(input.requestId) ||
    !uuid.test(input.leaseToken) ||
    !guestAnswerAttributionEvaluationFailureCodes.has(input.errorCode)
  ) {
    fail('INVALID_INPUT', 'Exact request, lease, and bounded error code are required')
  }
  const now = input.now ?? new Date()
  const changed = await client.guestAnswerAttributionEvaluationRequest.updateMany({
    where: {
      id: input.requestId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      status: 'RUNNING',
      leaseToken: input.leaseToken,
    },
    data: {
      status: input.ambiguous ? 'AMBIGUOUS' : 'FAILED',
      lastErrorCode: input.errorCode,
      failedAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
    },
  })
  if (changed.count !== 1) fail('CONFLICT', 'Evaluation failure could not be fenced')
}

export async function recoverStaleGuestAnswerAttributionEvaluationRequestsAction(
  input: { now?: Date; limit?: number },
  client: EvaluationClient = db,
) {
  const now = input.now ?? new Date()
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  const stale = await client.guestAnswerAttributionEvaluationRequest.findMany({
    where: { status: 'RUNNING', leaseExpiresAt: { lte: now } },
    orderBy: [{ leaseExpiresAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: requestSelect,
  })
  const recovered: {
    requestId: string
    state: 'QUEUED' | 'AMBIGUOUS'
    tenantId: string
    venueId: string
    answerHash: string
    evidenceSetHash: string
    attemptNumber: number
  }[] = []
  for (const request of stale) {
    const ambiguous = request.providerDispatchedAt !== null
    const changed = await client.guestAnswerAttributionEvaluationRequest.updateMany({
      where: {
        id: request.id,
        status: 'RUNNING',
        leaseToken: request.leaseToken,
        leaseExpiresAt: request.leaseExpiresAt,
      },
      data: ambiguous
        ? {
            status: 'AMBIGUOUS',
            lastErrorCode: 'WORKER_LOST_AFTER_PROVIDER_DISPATCH',
            failedAt: now,
            leaseToken: null,
            leaseExpiresAt: null,
          }
        : {
            status: 'QUEUED',
            leaseToken: null,
            leaseExpiresAt: null,
          },
    })
    if (changed.count === 1) {
      recovered.push({
        requestId: request.id,
        state: ambiguous ? 'AMBIGUOUS' : 'QUEUED',
        tenantId: request.tenantId,
        venueId: request.venueId,
        answerHash: request.answerHash,
        evidenceSetHash: request.evidenceSetHash,
        attemptNumber: request.attemptNumber,
      })
    }
  }
  return recovered
}
