import type { SupportRequestStatus } from '@pathfinder/contracts/support-workflow'
import { canTransitionSupportRequest } from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type SupportStatusTransitionClient = Pick<typeof db, '$transaction'>

export type SupportStatusTransitionActor =
  | {
      actorType: 'HUMAN'
      participantKind: 'OPERATOR' | 'CLIENT'
      actorId: string
      auditRole: string
    }
  | {
      actorType: 'AGENT'
      participantKind: 'AGENT'
      actorId: string
      auditRole: 'AGENT'
      agentIdentityId: string
      agentRunId: string
      workerId: string
      credentialId: string
      approvalGrantId: string
      capability: 'support:open'
      modelProvider?: string
      modelName?: string
      idempotencyKey: string
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

function assertAuthorizedTransition(
  actor: SupportStatusTransitionActor,
  toStatus: SupportRequestStatus,
) {
  const humanOperator = actor.actorType === 'HUMAN' && actor.participantKind === 'OPERATOR'
  const approvedAgentOpen =
    actor.actorType === 'AGENT' &&
    actor.participantKind === 'AGENT' &&
    actor.capability === 'support:open' &&
    toStatus === 'OPEN'
  if (!humanOperator && !approvedAgentOpen) {
    throw new SupportStatusTransitionError(
      'FORBIDDEN',
      'Only a human support operator or an approval-bound agent opening a draft may change support request status',
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
  assertAuthorizedTransition(input.actor, input.toStatus)
  return client.$transaction(async (tx) => {
    const request = await tx.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, version: true, clientVersion: true },
    })
    if (!request) throw new SupportStatusTransitionError('NOT_FOUND', 'Support request not found')
    if (request.version !== input.expectedVersion) {
      throw new SupportStatusTransitionError('CONFLICT', 'Support request changed; refresh it')
    }
    if (input.actor.actorType === 'AGENT' && request.status !== 'DRAFT') {
      throw new SupportStatusTransitionError(
        'FORBIDDEN',
        'Approval-bound agents may only open an existing support draft',
      )
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
        updatedByKind: input.actor.participantKind,
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
        actorKind: input.actor.participantKind,
        actorId: input.actor.actorId,
        fromStatus: request.status,
        toStatus: input.toStatus,
      },
      select: { id: true },
    })
    const auditEvidence = {
      tenantId: input.tenantId,
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
        participantGranted: false,
        messageSent: false,
      },
    }
    if (input.actor.actorType === 'AGENT') {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actor: {
            type: 'AGENT',
            role: 'AGENT',
            actorId: input.actor.actorId,
            agentIdentityId: input.actor.agentIdentityId,
            agentRunId: input.actor.agentRunId,
            workerId: input.actor.workerId,
            credentialId: input.actor.credentialId,
            approvalGrantId: input.actor.approvalGrantId,
            capability: input.actor.capability,
            ...(input.actor.modelProvider ? { modelProvider: input.actor.modelProvider } : {}),
            ...(input.actor.modelName ? { modelName: input.actor.modelName } : {}),
            idempotencyKey: input.actor.idempotencyKey,
          },
        },
        tx,
      )
    } else {
      await writeAuditLogStrict(
        {
          ...auditEvidence,
          actorId: input.actor.actorId,
          actorRole: input.actor.auditRole,
          actorType: input.actor.actorType,
        },
        tx,
      )
    }
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
