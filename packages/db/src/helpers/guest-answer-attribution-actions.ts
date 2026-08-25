import { createHash, randomUUID } from 'node:crypto'

import { canonicalEvaluationJson, type CanonicalJsonValue } from '@pathfinder/contracts/evaluation'
import {
  GuestAnswerEvidenceBundleSchema,
  type GuestAnswerClaimInput,
} from '@pathfinder/contracts/guest-answer-attribution'
import { createVerifiedGuestAnswerAttribution } from '@pathfinder/contracts/guest-answer-attribution-node'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type GuestAnswerAttributionActor = {
  type: 'HUMAN'
  id: string
  role: 'PLATFORM_ADMIN'
}

export type RecordGuestAnswerAttributionInput = {
  operationId: string
  tenantId: string
  venueId: string
  guestChatTurnId: string
  evaluator: {
    provider: string
    model: string
    configurationVersion: string
    promptVersion: string
  }
  claims: GuestAnswerClaimInput[]
  actor: GuestAnswerAttributionActor
}

export type GuestAnswerAttributionActionClient = Pick<typeof db, '$transaction'>
export type GuestAnswerAttributionActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'PRECONDITION_FAILED'
  | 'CONFLICT'

export class GuestAnswerAttributionActionError extends Error {
  constructor(
    readonly code: GuestAnswerAttributionActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuestAnswerAttributionActionError'
  }
}

const operationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function fail(code: GuestAnswerAttributionActionErrorCode, message: string): never {
  throw new GuestAnswerAttributionActionError(code, message)
}

function inputHash(input: RecordGuestAnswerAttributionInput): string {
  return createHash('sha256')
    .update(
      canonicalEvaluationJson({
        version: 'guest-answer-attribution-action-v1',
        tenantId: input.tenantId,
        venueId: input.venueId,
        guestChatTurnId: input.guestChatTurnId,
        evaluator: input.evaluator,
        claims: input.claims,
        actor: input.actor,
      } as CanonicalJsonValue),
    )
    .digest('hex')
}

function requireInput(input: RecordGuestAnswerAttributionInput): void {
  if (
    !input ||
    !operationIdPattern.test(input.operationId) ||
    !input.tenantId?.trim() ||
    !input.venueId?.trim() ||
    !operationIdPattern.test(input.guestChatTurnId) ||
    input.actor?.type !== 'HUMAN' ||
    input.actor.role !== 'PLATFORM_ADMIN' ||
    !input.actor.id.trim()
  ) {
    fail(
      'INVALID_INPUT',
      'Exact scope, operation identity, and human platform administrator are required',
    )
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002'
}

const attributionSelect = {
  id: true,
  operationId: true,
  inputHash: true,
  guestChatTurnId: true,
  schemaVersion: true,
  answerHash: true,
  evidenceSetHash: true,
  evaluatorProvider: true,
  evaluatorModel: true,
  evaluatorConfiguration: true,
  evaluatorPromptVersion: true,
  attributionSnapshot: true,
  claimCount: true,
  supportedCount: true,
  unsupportedCount: true,
  uncertainCount: true,
  nonFactualCount: true,
  supportRate: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} as const

export async function recordHumanReviewedGuestAnswerAttributionAction(
  input: RecordGuestAnswerAttributionInput,
  client: GuestAnswerAttributionActionClient = db,
) {
  requireInput(input)
  const exactInputHash = inputHash(input)

  const createOrReplay = () =>
    client.$transaction(async (rawTx) => {
      const tx = rawTx as unknown as typeof db
      const existing = await tx.guestAnswerAttribution.findFirst({
        where: { tenantId: input.tenantId, operationId: input.operationId },
        select: attributionSelect,
      })
      if (existing) {
        if (existing.inputHash !== exactInputHash) {
          fail('CONFLICT', 'Operation ID was already used for different attribution input')
        }
        return { attribution: existing, replayed: true as const }
      }

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
          'This answer predates exact claim-attribution evidence and cannot be reviewed safely',
        )
      }

      let attribution
      try {
        attribution = createVerifiedGuestAnswerAttribution({
          answer: turn.assistantMessage.content,
          evidence: evidence.data,
          evaluator: input.evaluator,
          claims: input.claims,
        })
      } catch (error) {
        fail(
          'INVALID_INPUT',
          error instanceof Error ? error.message : 'Claim attribution input is invalid',
        )
      }

      const created = await tx.guestAnswerAttribution.create({
        data: {
          id: randomUUID(),
          operationId: input.operationId,
          inputHash: exactInputHash,
          tenantId: input.tenantId,
          venueId: input.venueId,
          sessionId: turn.sessionId,
          guestChatTurnId: turn.id,
          schemaVersion: attribution.schemaVersion,
          answerHash: attribution.answerHash,
          evidenceSetHash: attribution.evidenceSetHash,
          evaluatorProvider: attribution.evaluator.provider,
          evaluatorModel: attribution.evaluator.model,
          evaluatorConfiguration: attribution.evaluator.configurationVersion,
          evaluatorPromptVersion: attribution.evaluator.promptVersion,
          attributionSnapshot: JSON.parse(JSON.stringify(attribution)),
          claimCount: attribution.metrics.claimCount,
          supportedCount: attribution.metrics.supportedCount,
          unsupportedCount: attribution.metrics.unsupportedCount,
          uncertainCount: attribution.metrics.uncertainCount,
          nonFactualCount: attribution.metrics.nonFactualCount,
          supportRate: attribution.metrics.supportRate,
          actorType: input.actor.type,
          actorId: input.actor.id,
        },
        select: attributionSelect,
      })
      await writeAuditLogStrict(
        {
          tenantId: input.tenantId,
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'guest-answer-attribution.recorded',
          targetType: 'GuestAnswerAttribution',
          targetId: created.id,
          sourceReferences: [`guest-chat-turn:${turn.id}`],
          afterState: {
            venueId: input.venueId,
            guestChatTurnId: turn.id,
            answerHash: attribution.answerHash,
            evidenceSetHash: attribution.evidenceSetHash,
            evaluator: attribution.evaluator,
            metrics: attribution.metrics,
          },
        },
        tx,
      )
      return { attribution: created, replayed: false as const }
    })

  try {
    return await createOrReplay()
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error
    return createOrReplay()
  }
}
