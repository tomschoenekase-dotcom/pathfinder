import { createHash } from 'node:crypto'
import { z } from 'zod'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { SupportActionError } from './support-actions'

const id = z.string().trim().min(1).max(191)
const base = z
  .object({
    operationId: z.string().uuid(),
    tenantId: id,
    venueId: id,
    requestId: id,
    userId: id,
    expectedClientVersion: z.number().int().positive(),
    actor: z
      .object({
        actorType: z.literal('HUMAN'),
        participantKind: z.literal('CLIENT'),
        actorId: id,
        auditRole: z.enum(['STAFF', 'MANAGER', 'OWNER']),
      })
      .strict(),
  })
  .strict()
type Input = z.infer<typeof base>
type Client = Pick<typeof db, '$transaction'>
type Transaction = Parameters<Parameters<Client['$transaction']>[0]>[0]

function parse(input: unknown): Input {
  const result = base.safeParse(input)
  if (!result.success) throw new SupportActionError('INVALID_INPUT', 'Invalid participant action')
  return result.data
}

function hash(kind: string, input: Input) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        domain: 'pathfinder.support-participant.v1',
        kind,
        tenantId: input.tenantId,
        venueId: input.venueId,
        requestId: input.requestId,
        userId: input.userId,
        actorId: input.actor.actorId,
        expectedClientVersion: input.expectedClientVersion,
      }),
    )
    .digest('hex')
}

async function lockRequest(tx: Transaction, input: Input) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`pathfinder:support-request:${input.tenantId}:${input.requestId}`}, 0))`
}

async function loadRequester(tx: Transaction, input: Input) {
  const request = await tx.supportRequest.findFirst({
    where: {
      id: input.requestId,
      tenantId: input.tenantId,
      venueId: input.venueId,
      createdByKind: 'CLIENT',
      requesterUserId: input.actor.actorId,
      requesterMembership: { is: { status: 'ACTIVE' } },
    },
    select: { id: true, version: true, clientVersion: true, requesterUserId: true },
  })
  if (!request) throw new SupportActionError('NOT_FOUND', 'Support request not found')
  return request
}

async function validateTargetMember(tx: Transaction, input: Input, requesterUserId: string | null) {
  if (input.userId === requesterUserId)
    throw new SupportActionError('INVALID_INPUT', 'Requester cannot be a participant')
  const membership = await tx.tenantMembership.findFirst({
    where: { tenantId: input.tenantId, userId: input.userId, status: 'ACTIVE' },
    select: { userId: true },
  })
  if (!membership) throw new SupportActionError('NOT_FOUND', 'Active tenant member not found')
}

async function grantSupportRequestParticipantActionOnce(input: Input, client: Client) {
  const parsed = parse(input)
  const operationHash = hash('GRANT', parsed)
  return client.$transaction(async (tx) => {
    await lockRequest(tx, parsed)
    const request = await loadRequester(tx, parsed)
    const replay = await tx.supportRequestParticipant.findFirst({
      where: { tenantId: parsed.tenantId, grantOperationId: parsed.operationId },
      select: {
        id: true,
        supportRequestId: true,
        userId: true,
        grantOperationHash: true,
        grantRequestVersion: true,
        grantClientVersion: true,
        grantActionAt: true,
        revokedAt: true,
      },
    })
    if (replay) {
      if (
        replay.supportRequestId !== parsed.requestId ||
        replay.userId !== parsed.userId ||
        replay.grantOperationHash !== operationHash
      )
        throw new SupportActionError('CONFLICT', 'Participant operation ID was already used')
      if (
        replay.grantRequestVersion === null ||
        replay.grantClientVersion === null ||
        replay.grantActionAt === null
      )
        throw new SupportActionError('CONFLICT', 'Participant operation evidence is incomplete')
      return {
        participantId: replay.id,
        requestVersion: replay.grantRequestVersion,
        clientVersion: replay.grantClientVersion,
        actionAt: replay.grantActionAt,
        active: true,
        replayed: true as const,
      }
    }
    await validateTargetMember(tx, parsed, request.requesterUserId)
    if (request.clientVersion !== parsed.expectedClientVersion)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const active = await tx.supportRequestParticipant.findFirst({
      where: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: parsed.requestId,
        userId: parsed.userId,
        revokedAt: null,
      },
      select: { id: true },
    })
    if (active) throw new SupportActionError('CONFLICT', 'Member already participates')
    const nextVersion = request.clientVersion + 1
    const nextRequestVersion = request.version + 1
    const actionAt = new Date()
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        version: request.version,
        clientVersion: parsed.expectedClientVersion,
        requesterUserId: parsed.actor.actorId,
      },
      data: {
        version: nextRequestVersion,
        clientVersion: nextVersion,
        clientActivityAt: actionAt,
        updatedByKind: 'CLIENT',
        updatedById: parsed.actor.actorId,
      },
    })
    if (changed.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const participant = await tx.supportRequestParticipant.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: parsed.requestId,
        userId: parsed.userId,
        grantOperationId: parsed.operationId,
        grantOperationHash: operationHash,
        grantRequestVersion: nextRequestVersion,
        grantClientVersion: nextVersion,
        grantActionAt: actionAt,
        grantedByKind: 'CLIENT',
        grantedById: parsed.actor.actorId,
        grantedAt: actionAt,
      },
      select: { id: true },
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: parsed.requestId,
        requestVersion: request.version + 1,
        eventType: 'CLIENT_PARTICIPANT_GRANTED',
        actorKind: 'CLIENT',
        actorId: parsed.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actorId: parsed.actor.actorId,
        actorRole: parsed.actor.auditRole,
        action: 'support-request.participant-granted',
        targetType: 'SupportRequest',
        targetId: parsed.requestId,
        beforeState: { clientVersion: request.clientVersion },
        afterState: { clientVersion: nextVersion, participantCountDelta: 1 },
      },
      tx,
    )
    return {
      participantId: participant.id,
      requestVersion: nextRequestVersion,
      clientVersion: nextVersion,
      actionAt,
      active: true,
      replayed: false as const,
    }
  })
}

async function revokeSupportRequestParticipantActionOnce(input: Input, client: Client) {
  const parsed = parse(input)
  const operationHash = hash('REVOKE', parsed)
  return client.$transaction(async (tx) => {
    await lockRequest(tx, parsed)
    const request = await loadRequester(tx, parsed)
    const replay = await tx.supportRequestParticipant.findFirst({
      where: { tenantId: parsed.tenantId, revokeOperationId: parsed.operationId },
      select: {
        id: true,
        supportRequestId: true,
        userId: true,
        revokeOperationHash: true,
        revokeRequestVersion: true,
        revokeClientVersion: true,
        revokeActionAt: true,
      },
    })
    if (replay) {
      if (
        replay.supportRequestId !== parsed.requestId ||
        replay.userId !== parsed.userId ||
        replay.revokeOperationHash !== operationHash
      )
        throw new SupportActionError('CONFLICT', 'Participant operation ID was already used')
      if (
        replay.revokeRequestVersion === null ||
        replay.revokeClientVersion === null ||
        replay.revokeActionAt === null
      )
        throw new SupportActionError('CONFLICT', 'Participant operation evidence is incomplete')
      return {
        participantId: replay.id,
        requestVersion: replay.revokeRequestVersion,
        clientVersion: replay.revokeClientVersion,
        actionAt: replay.revokeActionAt,
        active: false,
        replayed: true as const,
      }
    }
    await validateTargetMember(tx, parsed, request.requesterUserId)
    if (request.clientVersion !== parsed.expectedClientVersion)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const participant = await tx.supportRequestParticipant.findFirst({
      where: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: parsed.requestId,
        userId: parsed.userId,
        revokedAt: null,
      },
      select: { id: true },
    })
    if (!participant)
      throw new SupportActionError('NOT_FOUND', 'Active support participant not found')
    const nextVersion = request.clientVersion + 1
    const nextRequestVersion = request.version + 1
    const actionAt = new Date()
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        version: request.version,
        clientVersion: parsed.expectedClientVersion,
        requesterUserId: parsed.actor.actorId,
      },
      data: {
        version: nextRequestVersion,
        clientVersion: nextVersion,
        clientActivityAt: actionAt,
        updatedByKind: 'CLIENT',
        updatedById: parsed.actor.actorId,
      },
    })
    if (changed.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const revoked = await tx.supportRequestParticipant.updateMany({
      where: {
        id: participant.id,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        revokedAt: null,
      },
      data: {
        revokedAt: actionAt,
        revokedByKind: 'CLIENT',
        revokedById: parsed.actor.actorId,
        revokeOperationId: parsed.operationId,
        revokeOperationHash: operationHash,
        revokeRequestVersion: nextRequestVersion,
        revokeClientVersion: nextVersion,
        revokeActionAt: actionAt,
      },
    })
    if (revoked.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support participant changed; refresh it')
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        supportRequestId: parsed.requestId,
        requestVersion: request.version + 1,
        eventType: 'CLIENT_PARTICIPANT_REVOKED',
        actorKind: 'CLIENT',
        actorId: parsed.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actorId: parsed.actor.actorId,
        actorRole: parsed.actor.auditRole,
        action: 'support-request.participant-revoked',
        targetType: 'SupportRequest',
        targetId: parsed.requestId,
        beforeState: { clientVersion: request.clientVersion },
        afterState: { clientVersion: nextVersion, participantCountDelta: -1 },
      },
      tx,
    )
    return {
      participantId: participant.id,
      requestVersion: nextRequestVersion,
      clientVersion: nextVersion,
      actionAt,
      active: false,
      replayed: false as const,
    }
  })
}

function isUniqueConflict(error: unknown): error is { code: 'P2002' } {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

async function converge<T>(attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt()
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    try {
      return await attempt()
    } catch (replayError) {
      if (isUniqueConflict(replayError))
        throw new SupportActionError('CONFLICT', 'Participant operation could not be reconciled')
      throw replayError
    }
  }
}

export function grantSupportRequestParticipantAction(input: Input, client: Client = db) {
  return converge(() => grantSupportRequestParticipantActionOnce(input, client))
}

export function revokeSupportRequestParticipantAction(input: Input, client: Client = db) {
  return converge(() => revokeSupportRequestParticipantActionOnce(input, client))
}
