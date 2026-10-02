import { createHash } from 'node:crypto'

import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = Pick<typeof db, '$transaction'>

const id = z.string().trim().min(1).max(191)
const createInput = z
  .object({
    operationId: z.string().uuid(),
    tenantId: id,
    venueId: id,
    category: z.enum([
      'CONTENT_CORRECTION',
      'OPERATIONAL_UPDATE',
      'BRANDING',
      'EXPERIENCE_BEHAVIOR',
      'ACCESSIBILITY',
      'GENERAL',
    ]),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']),
    recipientUserId: id,
    questionIds: z.array(id).max(10).default([]),
    actor: z.object({ actorId: id, auditRole: z.literal('PLATFORM_ADMIN') }).strict(),
  })
  .strict()

export type CreateOperatorSupportRequestInput = z.input<typeof createInput>

export class OperatorSupportRequestError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'OperatorSupportRequestError'
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

export function operatorSupportRequestOperationHash(input: z.output<typeof createInput>): string {
  return createHash('sha256')
    .update(
      canonical({
        domain: 'pathfinder.support-operator-request.v1',
        tenantId: input.tenantId,
        venueId: input.venueId,
        category: input.category,
        subject: input.subject,
        body: input.body,
        priority: input.priority,
        recipientUserId: input.recipientUserId,
        questionIds: [...input.questionIds].sort(),
        actorId: input.actor.actorId,
      }),
    )
    .digest('hex')
}

/**
 * Creates one support conversation on behalf of an approving operator, with a client-visible
 * first message, and gives exactly one ACTIVE member of this tenant access to it. Linked
 * questions are references only: nothing is resumed, answered or authorized by them. Replays
 * with the same operation id return the original request; a changed replay conflicts.
 */
export async function createOperatorSupportRequestAction(
  rawInput: CreateOperatorSupportRequestInput,
  client: Client = db,
) {
  const input = createInput.parse(rawInput)
  if (new Set(input.questionIds).size !== input.questionIds.length)
    throw new OperatorSupportRequestError('INVALID_INPUT', 'Question identities must be unique')
  const operationHash = operatorSupportRequestOperationHash(input)

  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-operation:${input.tenantId}:${input.operationId}`}, 0))`
    const replay = await tx.supportMessage.findFirst({
      where: { tenantId: input.tenantId, submissionRequestId: input.operationId },
      select: {
        id: true,
        supportRequestId: true,
        venueId: true,
        submissionInputHash: true,
        supportRequest: { select: { id: true, status: true, version: true } },
      },
    })
    if (replay) {
      if (replay.submissionInputHash !== operationHash || replay.venueId !== input.venueId)
        throw new OperatorSupportRequestError('CONFLICT', 'Support operation ID was already used')
      return {
        requestId: replay.supportRequestId,
        messageId: replay.id,
        status: replay.supportRequest.status,
        requestVersion: replay.supportRequest.version,
        questionTexts: [] as string[],
        replayed: true as const,
      }
    }

    const [venue, member, questions] = await Promise.all([
      tx.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      }),
      tx.tenantMembership.findFirst({
        where: { tenantId: input.tenantId, userId: input.recipientUserId, status: 'ACTIVE' },
        select: { id: true },
      }),
      input.questionIds.length === 0
        ? Promise.resolve([])
        : tx.agentQuestion.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              id: { in: input.questionIds },
            },
            select: { id: true, question: true, status: true },
          }),
    ])
    if (!venue || !member || questions.length !== input.questionIds.length)
      throw new OperatorSupportRequestError('NOT_FOUND', 'Venue, recipient or question not found')
    if (questions.some((question) => question.status !== 'PENDING'))
      throw new OperatorSupportRequestError('CONFLICT', 'A linked question is no longer pending')
    // Keep the caller's order so the checklist and the email read the way they were proposed.
    const questionTexts = input.questionIds.map(
      (questionId) => questions.find((question) => question.id === questionId)!.question,
    )

    const now = new Date()
    const status = questions.length > 0 ? ('WAITING_FOR_CLIENT' as const) : ('OPEN' as const)
    const request = await tx.supportRequest.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        category: input.category,
        status,
        subject: input.subject,
        missingInformation: questionTexts,
        artifacts: {
          operatorCreated: true,
          operatorPriority: input.priority,
          ...(input.questionIds.length > 0 ? { linkedQuestionIds: input.questionIds } : {}),
        },
        version: 1,
        clientVersion: 1,
        clientActivityAt: now,
        statusChangedAt: now,
        createdByKind: 'OPERATOR',
        createdById: input.actor.actorId,
        requesterUserId: null,
        updatedByKind: 'OPERATOR',
        updatedById: input.actor.actorId,
      },
      select: { id: true, status: true, version: true },
    })
    const message = await tx.supportMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        authorKind: 'OPERATOR',
        authorId: input.actor.actorId,
        visibility: 'CLIENT_VISIBLE',
        body: input.body,
        submissionRequestId: input.operationId,
        submissionInputHash: operationHash,
        clientVersion: 1,
        requestVersion: 1,
        createdAt: now,
      },
      select: { id: true },
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: 1,
        eventType: 'REQUEST_CREATED',
        actorKind: 'OPERATOR',
        actorId: input.actor.actorId,
        fromStatus: null,
        toStatus: null,
        createdAt: now,
      },
      select: { id: true },
    })
    await tx.supportRequestParticipant.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        userId: input.recipientUserId,
        grantOperationId: input.operationId,
        grantOperationHash: operationHash,
        grantRequestVersion: 1,
        grantClientVersion: 1,
        grantActionAt: now,
        grantedByKind: 'OPERATOR',
        grantedById: input.actor.actorId,
        grantedAt: now,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'support-request.created-by-operator',
        targetType: 'SupportRequest',
        targetId: request.id,
        afterState: {
          venueId: input.venueId,
          category: input.category,
          status: request.status,
          priority: input.priority,
          version: request.version,
          messageVisibility: 'CLIENT_VISIBLE',
          recipientUserId: input.recipientUserId,
          linkedQuestionCount: input.questionIds.length,
        },
      },
      tx,
    )
    return {
      requestId: request.id,
      messageId: message.id,
      status: request.status,
      requestVersion: request.version,
      questionTexts,
      replayed: false as const,
    }
  })
}
