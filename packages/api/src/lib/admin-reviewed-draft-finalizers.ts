import { TRPCError } from '@trpc/server'

import { writeAuditLogStrict } from '@pathfinder/db'

import type { VenuePackageDraftFinalizer } from './venue-package-draft-finalizer'

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message })
}

function assertPackage(input: Parameters<VenuePackageDraftFinalizer>[0], actorId: string) {
  if (input.createdBy !== actorId) conflict('Draft request is bound to another actor')
  if (!input.replayed && input.status !== 'DRAFT') conflict('Only a new DRAFT may be attached')
  if (input.preview.report.semanticDuplicateScan.status !== 'COMPLETE') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Reviewed DRAFT requires complete semantic evidence',
    })
  }
}

export function standaloneReviewedDraftFinalizer(actorId: string): VenuePackageDraftFinalizer {
  return async (input) => {
    assertPackage(input, actorId)
    return { packageId: input.packageId, replayed: input.replayed }
  }
}

export function supportReviewedDraftFinalizer(params: {
  actorId: string
  supportRequestId: string
  expectedVersion: number
}): VenuePackageDraftFinalizer {
  return async (input) => {
    assertPackage(input, params.actorId)
    const replay = await input.tx.supportPackageHandoff.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        venuePackageId: input.packageId,
      },
      select: { supportRequestId: true, requestVersion: true, linkedById: true },
    })
    if (input.replayed) {
      if (
        replay?.supportRequestId !== params.supportRequestId ||
        replay.linkedById !== params.actorId ||
        replay.requestVersion !== params.expectedVersion + 1
      ) {
        conflict('Draft request is not the exact support handoff replay')
      }
      return { requestVersion: replay.requestVersion, replayed: true }
    }
    if (replay) conflict('Draft is already linked')
    const request = await input.tx.supportRequest.findFirst({
      where: {
        id: params.supportRequestId,
        tenantId: input.tenantId,
        venueId: input.venueId,
      },
      select: { id: true, status: true, version: true },
    })
    if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
    if (request.status === 'COMPLETED' || request.status === 'CANCELLED') {
      conflict('Closed support requests cannot create a package handoff')
    }
    if (request.version !== params.expectedVersion) conflict('Support request changed; refresh it')
    const nextVersion = request.version + 1
    const changed = await input.tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        version: params.expectedVersion,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      data: { version: nextVersion, updatedByKind: 'OPERATOR', updatedById: params.actorId },
    })
    if (changed.count !== 1) conflict('Support request changed; refresh it')
    await input.tx.supportPackageHandoff.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        venuePackageId: input.packageId,
        requestVersion: nextVersion,
        linkedByKind: 'OPERATOR',
        linkedById: params.actorId,
      },
    })
    await input.tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: 'PACKAGE_DRAFT_CREATED_AND_LINKED',
        actorKind: 'OPERATOR',
        actorId: params.actorId,
        fromStatus: null,
        toStatus: null,
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'support-request.reviewed-draft-created-and-linked',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: { status: request.status, version: request.version },
        afterState: {
          status: request.status,
          version: nextVersion,
          venuePackageId: input.packageId,
          packageStatus: 'DRAFT',
        },
      },
      input.tx,
    )
    return { requestVersion: nextVersion, replayed: false }
  }
}

export function intakeReviewedDraftFinalizer(params: {
  actorId: string
  intakeRunId: string
}): VenuePackageDraftFinalizer {
  return async (input) => {
    assertPackage(input, params.actorId)
    const replay = await input.tx.intakePackageHandoff.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        packageDraftId: input.packageId,
      },
      select: { runId: true, createdBy: true },
    })
    if (input.replayed) {
      if (replay?.runId !== params.intakeRunId || replay.createdBy !== params.actorId) {
        conflict('Draft request is not the exact intake handoff replay')
      }
      return { replayed: true }
    }
    if (replay) conflict('Draft is already linked')
    const run = await input.tx.intakeRun.findFirst({
      where: {
        id: params.intakeRunId,
        tenantId: input.tenantId,
        venueId: input.venueId,
        status: 'AWAITING_REVIEW',
      },
      select: { id: true, status: true },
    })
    if (!run) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Awaiting-review intake proposal not found',
      })
    }
    const existing = await input.tx.intakePackageHandoff.findFirst({
      where: { tenantId: input.tenantId, venueId: input.venueId, runId: run.id },
      select: { id: true },
    })
    if (existing) conflict('Intake proposal already has a package handoff')
    await input.tx.intakePackageHandoff.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: run.id,
        packageDraftId: input.packageId,
        createdBy: params.actorId,
      },
    })
    await input.tx.intakeRunEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        runId: run.id,
        kind: 'PACKAGE_DRAFT_LINKED',
        actorId: params.actorId,
        metadata: { packageDraftId: input.packageId, statusRequired: 'DRAFT' },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: params.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'intake.reviewed-draft-created-and-linked',
        targetType: 'IntakeRun',
        targetId: run.id,
        beforeState: { status: run.status, packageLinked: false },
        afterState: {
          status: run.status,
          packageLinked: true,
          venuePackageId: input.packageId,
          packageStatus: 'DRAFT',
        },
      },
      input.tx,
    )
    return { replayed: false }
  }
}
