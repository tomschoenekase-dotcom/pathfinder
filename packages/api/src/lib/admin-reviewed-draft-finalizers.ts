import { TRPCError } from '@trpc/server'

import {
  SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
  SUPPORT_PACKAGE_DRAFT_CAPABILITY,
  SupportPackageDraftApplyParameters,
} from '@pathfinder/contracts'
import type { MachineActorContext } from '@pathfinder/contracts/actor'
import {
  consumeApprovalGrantAction,
  supportPackageDraftPayloadHash,
  writeAuditLogStrict,
} from '@pathfinder/db'

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

export function supportAgentReviewedDraftFinalizer(params: {
  actor: MachineActorContext
  operationId: string
  supportRequestId: string
  expectedVersion: number
  fromStatus: 'OPEN' | 'IN_REVIEW'
  draftKey: string
  payload: Record<string, unknown>
  proposalPayloadHash: string
  operationCounts: SupportPackageDraftApplyParameters['operationCounts']
}): VenuePackageDraftFinalizer {
  return async (input) => {
    assertPackage(input, params.actor.actorId)
    if (!params.actor.approvalGrantId) conflict('Package draft requires an approval grant')
    if (!params.actor.idempotencyKey || params.actor.idempotencyKey !== params.operationId) {
      conflict('Package draft operation identity is invalid')
    }
    if (supportPackageDraftPayloadHash(params.payload) !== params.proposalPayloadHash) {
      conflict('Package draft payload no longer matches the approved proposal')
    }
    const parameters = SupportPackageDraftApplyParameters.parse({
      clientId: input.tenantId,
      venueId: input.venueId,
      requestId: params.supportRequestId,
      expectedVersion: params.expectedVersion,
      fromStatus: params.fromStatus,
      draftKey: params.draftKey,
      payload: params.payload,
      proposalPayloadHash: params.proposalPayloadHash,
      operationCounts: params.operationCounts,
    })
    const sameTransaction = {
      $transaction: async (callback: (inner: typeof input.tx) => unknown) => callback(input.tx),
    } as never
    const consumption = await consumeApprovalGrantAction(
      {
        tenantId: input.tenantId,
        venueId: input.venueId,
        approvalGrantId: params.actor.approvalGrantId,
        operationId: params.operationId,
        actionName: SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
        capability: SUPPORT_PACKAGE_DRAFT_CAPABILITY,
        parameters,
        actor: params.actor,
      },
      sameTransaction,
    )
    const replay = await input.tx.supportPackageHandoff.findFirst({
      where: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        venuePackageId: input.packageId,
      },
      select: {
        id: true,
        supportRequestId: true,
        requestVersion: true,
        linkedByKind: true,
        linkedById: true,
      },
    })
    const resultReference = replay
      ? `VenuePackage:${input.packageId}:SupportPackageHandoff:${replay.id}:SupportRequest:${params.supportRequestId}:v${replay.requestVersion}:DRAFT`
      : null
    if (input.replayed) {
      if (
        !consumption.replayed ||
        replay?.supportRequestId !== params.supportRequestId ||
        replay.linkedByKind !== 'AGENT' ||
        replay.linkedById !== params.actor.agentIdentityId ||
        replay.requestVersion !== params.expectedVersion + 1 ||
        consumption.consumption.resultReference !== resultReference
      ) {
        conflict('Package draft request is not the exact approved support handoff replay')
      }
      return {
        packageId: input.packageId,
        handoffId: replay.id,
        requestVersion: replay.requestVersion,
        replayed: true,
      }
    }
    if (consumption.replayed || replay) conflict('Approved package draft is already linked')
    const [request, run] = await Promise.all([
      input.tx.supportRequest.findFirst({
        where: {
          id: params.supportRequestId,
          tenantId: input.tenantId,
          venueId: input.venueId,
        },
        select: { id: true, status: true, version: true, missingInformation: true },
      }),
      input.tx.agentRun.findFirst({
        where: {
          id: params.actor.agentRunId,
          tenantId: input.tenantId,
          venueId: input.venueId,
          agentIdentityId: params.actor.agentIdentityId,
        },
        select: { requestedOperation: true },
      }),
    ])
    if (!request) throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
    if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent run not found' })
    if (request.status !== params.fromStatus || request.version !== params.expectedVersion) {
      conflict('Support request changed; refresh it')
    }
    if (request.missingInformation.length > 0) {
      conflict('Requested information must be resolved before creating a package draft')
    }
    const nextVersion = request.version + 1
    const changed = await input.tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        version: params.expectedVersion,
        status: params.fromStatus,
      },
      data: {
        version: nextVersion,
        updatedByKind: 'AGENT',
        updatedById: params.actor.agentIdentityId,
      },
    })
    if (changed.count !== 1) conflict('Support request changed; refresh it')
    const handoff = await input.tx.supportPackageHandoff.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        venuePackageId: input.packageId,
        requestVersion: nextVersion,
        linkedByKind: 'AGENT',
        linkedById: params.actor.agentIdentityId,
      },
      select: { id: true },
    })
    await input.tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: 'PACKAGE_DRAFT_CREATED_AND_LINKED',
        actorKind: 'AGENT',
        actorId: params.actor.agentIdentityId,
        fromStatus: null,
        toStatus: null,
      },
    })
    const action = await input.tx.agentAction.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: params.actor.agentRunId,
        agentIdentityId: params.actor.agentIdentityId,
        actorType: 'AGENT',
        actorId: params.actor.agentIdentityId,
        requestedOperation: run.requestedOperation,
        actionName: 'torchiko.support.apply_package_draft',
        inputSummary: `Create and link approved ${params.operationCounts.total}-operation V3 package DRAFT.`,
        inputReference: `ApprovalGrant:${params.actor.approvalGrantId}`,
        output: {
          venuePackageId: input.packageId,
          supportPackageHandoffId: handoff.id,
          requestVersion: nextVersion,
          packageStatus: 'DRAFT',
          packageApproved: false,
          packageApplied: false,
          packagePublished: false,
        },
        modelProvider: params.actor.modelProvider ?? null,
        modelName: params.actor.modelName ?? null,
        status: 'SUCCEEDED',
        beforeVersionRef: `SupportRequest:${request.id}:v${request.version}`,
        afterVersionRef: `SupportRequest:${request.id}:v${nextVersion}:VenuePackage:${input.packageId}:DRAFT`,
      },
      select: { id: true },
    })
    await input.tx.agentTimelineEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        agentRunId: params.actor.agentRunId,
        agentActionId: action.id,
        actorType: 'AGENT',
        actorId: params.actor.agentIdentityId,
        eventType: 'support-package-draft.created-and-linked',
        message: 'The exact approved package DRAFT was created and linked for operator review.',
        data: {
          venuePackageId: input.packageId,
          supportPackageHandoffId: handoff.id,
          requestId: request.id,
          requestVersion: nextVersion,
          packageStatus: 'DRAFT',
          operationCounts: params.operationCounts,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actor: params.actor,
        action: 'support-request.approved-package-draft-created-and-linked',
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: { status: request.status, version: request.version },
        afterState: {
          status: request.status,
          version: nextVersion,
          venuePackageId: input.packageId,
          packageStatus: 'DRAFT',
          packageApproved: false,
          packageApplied: false,
          packagePublished: false,
          customerContacted: false,
          operationCounts: params.operationCounts,
        },
      },
      input.tx,
    )
    const reference = `VenuePackage:${input.packageId}:SupportPackageHandoff:${handoff.id}:SupportRequest:${request.id}:v${nextVersion}:DRAFT`
    await input.tx.approvalGrantConsumption.update({
      where: { id: consumption.consumption.id },
      data: { resultReference: reference },
    })
    return {
      packageId: input.packageId,
      handoffId: handoff.id,
      requestVersion: nextVersion,
      replayed: false,
    }
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
