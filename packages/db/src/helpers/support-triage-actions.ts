import {
  SupportRequestCategory,
  type SupportRequestCategory as SupportRequestCategoryType,
} from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { SupportActionError } from './support-actions'

export const SUPPORT_TRIAGE_MISSING_INFORMATION_MAX = 30
export const SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX = 500

export type SupportTriageActor = {
  actorType: 'HUMAN'
  participantKind: 'OPERATOR'
  actorId: string
  auditRole: string
}

type SupportTriageClient = Pick<typeof db, '$transaction'>

function assertHumanOperator(actor: SupportTriageActor): void {
  if (
    actor.actorType !== 'HUMAN' ||
    actor.participantKind !== 'OPERATOR' ||
    actor.actorId.trim().length === 0 ||
    actor.auditRole.trim().length === 0
  ) {
    throw new SupportActionError('FORBIDDEN', 'Only a human support operator may record triage')
  }
}

export function normalizeSupportMissingInformation(values: readonly string[]): string[] {
  if (values.length > SUPPORT_TRIAGE_MISSING_INFORMATION_MAX) {
    throw new SupportActionError(
      'CONFLICT',
      `Support triage accepts at most ${SUPPORT_TRIAGE_MISSING_INFORMATION_MAX} missing-information items`,
    )
  }
  const normalized = values.map((value) => value.trim())
  if (
    normalized.some(
      (value) => value.length === 0 || value.length > SUPPORT_TRIAGE_MISSING_INFORMATION_ITEM_MAX,
    )
  ) {
    throw new SupportActionError('CONFLICT', 'Support missing-information item is invalid')
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new SupportActionError('CONFLICT', 'Support missing-information items must be unique')
  }
  return normalized
}

/** Records structured triage only. It never changes status, sends a message, or touches artifacts. */
export async function triageSupportRequestAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    expectedVersion: number
    category: SupportRequestCategoryType
    missingInformation: readonly string[]
    actor: SupportTriageActor
  },
  client: SupportTriageClient = db,
) {
  assertHumanOperator(input.actor)
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new SupportActionError('CONFLICT', 'Support request version is invalid')
  }
  const category = SupportRequestCategory.safeParse(input.category)
  if (!category.success) throw new SupportActionError('CONFLICT', 'Support category is invalid')
  const missingInformation = normalizeSupportMissingInformation(input.missingInformation)

  return client.$transaction(async (tx) => {
    const request = await tx.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: {
        id: true,
        category: true,
        status: true,
        missingInformation: true,
        version: true,
        clientVersion: true,
      },
    })
    if (!request) throw new SupportActionError('NOT_FOUND', 'Support request not found')
    if (request.status === 'COMPLETED' || request.status === 'CANCELLED') {
      throw new SupportActionError('CONFLICT', 'Closed support requests cannot be triaged')
    }
    if (request.version !== input.expectedVersion) {
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    }

    const nextVersion = request.version + 1
    const clientActivityAt = new Date()
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        version: input.expectedVersion,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: {
        category: category.data,
        missingInformation,
        version: nextVersion,
        clientVersion: request.clientVersion + 1,
        clientActivityAt,
        updatedByKind: 'OPERATOR',
        updatedById: input.actor.actorId,
      },
    })
    if (changed.count !== 1) {
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    }

    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: 'TRIAGE_UPDATED',
        actorKind: 'OPERATOR',
        actorId: input.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'support-request.triage-updated',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: {
          category: request.category,
          missingInformationCount: request.missingInformation.length,
          version: request.version,
        },
        afterState: {
          category: category.data,
          missingInformationCount: missingInformation.length,
          version: nextVersion,
          statusChanged: false,
          messageSent: false,
          artifactsChanged: false,
          packageLifecycleChanged: false,
          executionTriggered: false,
        },
      },
      tx,
    )

    return {
      id: request.id,
      category: category.data,
      missingInformation,
      version: nextVersion,
      clientVersion: request.clientVersion + 1,
      clientActivityAt,
    }
  })
}
