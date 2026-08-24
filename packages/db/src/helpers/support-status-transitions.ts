import type { SupportRequestStatus } from '@pathfinder/contracts/support-workflow'
import { canTransitionSupportRequest } from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type SupportStatusTransitionClient = Pick<typeof db, '$transaction'>

export type SupportStatusTransitionActor = {
  actorType: 'HUMAN'
  participantKind: 'OPERATOR' | 'CLIENT'
  actorId: string
  auditRole: string
}

export class SupportStatusTransitionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'SupportStatusTransitionError'
  }
}

function assertOperator(actor: SupportStatusTransitionActor) {
  if (actor.actorType !== 'HUMAN' || actor.participantKind !== 'OPERATOR') {
    throw new SupportStatusTransitionError(
      'FORBIDDEN',
      'Only a human support operator may change support request status',
    )
  }
}

/** Records support workflow state only. It never changes or executes a package. */
export async function transitionSupportRequestStatusAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    expectedVersion: number
    toStatus: SupportRequestStatus
    actor: SupportStatusTransitionActor
    changedAt?: Date | undefined
  },
  client: SupportStatusTransitionClient = db,
) {
  assertOperator(input.actor)
  return client.$transaction(async (tx) => {
    const request = await tx.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, version: true, clientVersion: true },
    })
    if (!request) throw new SupportStatusTransitionError('NOT_FOUND', 'Support request not found')
    if (request.version !== input.expectedVersion) {
      throw new SupportStatusTransitionError('CONFLICT', 'Support request changed; refresh it')
    }
    if (!canTransitionSupportRequest(request.status, input.toStatus)) {
      throw new SupportStatusTransitionError(
        'CONFLICT',
        `Support request cannot move from ${request.status} to ${input.toStatus}`,
      )
    }

    const nextVersion = request.version + 1
    const statusChangedAt = input.changedAt ?? new Date()
    const clientVisibleTransition = request.status !== 'DRAFT'
    const nextClientVersion = request.clientVersion + (clientVisibleTransition ? 1 : 0)
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        version: input.expectedVersion,
        status: request.status,
      },
      data: {
        status: input.toStatus,
        statusChangedAt,
        version: nextVersion,
        clientVersion: nextClientVersion,
        ...(clientVisibleTransition ? { clientActivityAt: statusChangedAt } : {}),
        updatedByKind: 'OPERATOR',
        updatedById: input.actor.actorId,
      },
    })
    if (changed.count !== 1) {
      throw new SupportStatusTransitionError('CONFLICT', 'Support request changed; refresh it')
    }

    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: 'STATUS_CHANGED',
        actorKind: 'OPERATOR',
        actorId: input.actor.actorId,
        fromStatus: request.status,
        toStatus: input.toStatus,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'support-request.status-changed',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: { status: request.status, version: request.version },
        afterState: {
          status: input.toStatus,
          version: nextVersion,
          packageLifecycleChanged: false,
          executionTriggered: false,
          customerContacted: false,
        },
      },
      tx,
    )
    return {
      id: request.id,
      status: input.toStatus,
      version: nextVersion,
      clientVersion: nextClientVersion,
      ...(clientVisibleTransition ? { clientActivityAt: statusChangedAt } : {}),
      statusChangedAt,
    }
  })
}
