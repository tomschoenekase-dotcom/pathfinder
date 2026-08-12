import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { lockVenueContentMutation } from './venue-content-lock'

type SupportPackageHandoffClient = Pick<typeof db, '$transaction'>

export type SupportPackageHandoffActor = {
  actorType: 'HUMAN'
  participantKind: 'OPERATOR' | 'CLIENT'
  actorId: string
  auditRole: string
}

export class SupportPackageHandoffError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageHandoffError'
  }
}

function assertOperator(actor: SupportPackageHandoffActor) {
  if (actor.actorType !== 'HUMAN' || actor.participantKind !== 'OPERATOR') {
    throw new SupportPackageHandoffError(
      'FORBIDDEN',
      'Only a human support operator may link a draft package',
    )
  }
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

/**
 * Links one existing DRAFT package to a support request. The package is only
 * read: this action never creates it or changes its lifecycle status.
 */
export async function linkSupportRequestDraftPackageAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    venuePackageId: string
    expectedVersion: number
    actor: SupportPackageHandoffActor
  },
  client: SupportPackageHandoffClient = db,
) {
  assertOperator(input.actor)
  try {
    return await client.$transaction(async (tx) => {
      await lockVenueContentMutation(tx, {
        tenantId: input.tenantId,
        venueId: input.venueId,
      })
      const request = await tx.supportRequest.findFirst({
        where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true, status: true, version: true },
      })
      if (!request) throw new SupportPackageHandoffError('NOT_FOUND', 'Support request not found')
      if (request.status === 'COMPLETED' || request.status === 'CANCELLED') {
        throw new SupportPackageHandoffError('CONFLICT', 'Closed support requests cannot be linked')
      }
      if (request.version !== input.expectedVersion) {
        throw new SupportPackageHandoffError('CONFLICT', 'Support request changed; refresh it')
      }

      const venuePackage = await tx.venuePackage.findFirst({
        where: { id: input.venuePackageId, tenantId: input.tenantId, venueId: input.venueId },
        select: { id: true, status: true },
      })
      if (!venuePackage)
        throw new SupportPackageHandoffError('NOT_FOUND', 'Venue package not found')
      if (venuePackage.status !== 'DRAFT') {
        throw new SupportPackageHandoffError('CONFLICT', 'Only a DRAFT venue package may be linked')
      }

      const duplicate = await tx.supportPackageHandoff.findFirst({
        where: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          OR: [
            { supportRequestId: request.id, venuePackageId: venuePackage.id },
            { venuePackageId: venuePackage.id },
          ],
        },
        select: { id: true },
      })
      if (duplicate) {
        throw new SupportPackageHandoffError('CONFLICT', 'This draft package is already linked')
      }

      const nextVersion = request.version + 1
      const changed = await tx.supportRequest.updateMany({
        where: {
          id: request.id,
          tenantId: input.tenantId,
          venueId: input.venueId,
          version: input.expectedVersion,
          status: { notIn: ['COMPLETED', 'CANCELLED'] },
        },
        data: {
          version: nextVersion,
          updatedByKind: 'OPERATOR',
          updatedById: input.actor.actorId,
        },
      })
      if (changed.count !== 1) {
        throw new SupportPackageHandoffError('CONFLICT', 'Support request changed; refresh it')
      }

      const handoff = await tx.supportPackageHandoff.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          supportRequestId: request.id,
          venuePackageId: venuePackage.id,
          requestVersion: nextVersion,
          linkedByKind: 'OPERATOR',
          linkedById: input.actor.actorId,
        },
        select: {
          id: true,
          tenantId: true,
          venueId: true,
          supportRequestId: true,
          venuePackageId: true,
          requestVersion: true,
          linkedByKind: true,
          linkedById: true,
          createdAt: true,
        },
      })

      await tx.supportRequestAuditEvent.create({
        data: {
          tenantId: input.tenantId,
          venueId: input.venueId,
          supportRequestId: request.id,
          requestVersion: nextVersion,
          eventType: 'PACKAGE_DRAFT_LINKED',
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
          action: 'support-request.draft-package-linked',
          targetType: 'SupportRequest',
          targetId: request.id,
          beforeState: { status: request.status, version: request.version },
          afterState: {
            status: request.status,
            version: nextVersion,
            venuePackageId: venuePackage.id,
            packageLifecycleChanged: false,
          },
        },
        tx,
      )
      return { handoff, requestVersion: nextVersion }
    })
  } catch (error) {
    if (isUniqueConflict(error)) {
      throw new SupportPackageHandoffError('CONFLICT', 'This draft package is already linked')
    }
    throw error
  }
}
