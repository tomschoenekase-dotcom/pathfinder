import { z } from 'zod'

import {
  SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION,
  SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY,
  SupportPackageHandoffSupersessionProposalSnapshot,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'
import { db, writeAuditLogStrict } from '@pathfinder/db'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()
const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact packages:reconcile capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support package handoff supersession proposals require an idempotency key.',
    })
  }
})
const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    requestId: z.string().trim().min(1).max(191),
    expectedVersion: z.number().int().positive(),
    supersededHandoffId: z.string().trim().min(1).max(191),
    replacementHandoffId: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(20).default([]),
    actor: proposalActor,
  })
  .strict()
  .refine((value) => value.supersededHandoffId !== value.replacementHandoffId, {
    path: ['replacementHandoffId'],
    message: 'Replacement handoff must differ from the superseded handoff.',
  })

export type PrepareSupportPackageHandoffSupersessionProposalInput = z.input<typeof inputSchema>

export class SupportPackageHandoffSupersessionProposalError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageHandoffSupersessionProposalError'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Freezes one exact reverted handoff and one separately linked, fully applied
 * replacement for founder review. It changes no support or package state. */
export async function prepareSupportPackageHandoffSupersessionProposalAction(
  input: PrepareSupportPackageHandoffSupersessionProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageHandoffSupersessionProposalError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ??
        'Support package handoff supersession proposal is invalid.',
    )
  }
  const parsed = parsedResult.data
  return client.$transaction(async (tx) => {
    const existing = await tx.approvalRequest.findUnique({
      where: { id: parsed.operationId },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        proposedAction: true,
        scopeSnapshot: true,
        artifacts: true,
        reason: true,
        createdAt: true,
      },
    })
    if (existing) {
      const snapshot = SupportPackageHandoffSupersessionProposalSnapshot.safeParse(
        existing.scopeSnapshot,
      )
      if (
        existing.tenantId !== parsed.tenantId ||
        existing.venueId !== parsed.venueId ||
        existing.agentIdentityId !== parsed.actor.agentIdentityId ||
        existing.agentRunId !== parsed.actor.agentRunId ||
        existing.proposedAction !== SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION ||
        existing.reason !== parsed.reason ||
        !snapshot.success ||
        snapshot.data.requestId !== parsed.requestId ||
        snapshot.data.expectedVersion !== parsed.expectedVersion ||
        snapshot.data.superseded.handoffId !== parsed.supersededHandoffId ||
        snapshot.data.replacement.handoffId !== parsed.replacementHandoffId ||
        canonicalJson(existing.artifacts) !== canonicalJson(parsed.evidence)
      ) {
        throw new SupportPackageHandoffSupersessionProposalError(
          'CONFLICT',
          'Support package handoff supersession proposal operation ID was already used.',
        )
      }
      return { approvalRequest: existing, snapshot: snapshot.data, replayed: true as const }
    }

    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: parsed.actor.agentIdentityId,
        tenantId: parsed.tenantId,
        enabled: true,
        accessCapabilities: { has: SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY },
        OR: [
          { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
          { accessScope: 'VENUE', venueId: parsed.venueId },
        ],
      },
      select: { id: true },
    })
    if (!identity) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'FORBIDDEN',
        'Enabled package-reconciliation agent identity is not in scope.',
      )
    }
    const [run, request, handoffs] = await Promise.all([
      tx.agentRun.findFirst({
        where: {
          id: parsed.actor.agentRunId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          status: 'RUNNING',
        },
        select: { id: true, requestedOperation: true },
      }),
      tx.supportRequest.findFirst({
        where: { id: parsed.requestId, tenantId: parsed.tenantId, venueId: parsed.venueId },
        select: { id: true, version: true, status: true, clientVersion: true },
      }),
      tx.supportPackageHandoff.findMany({
        where: {
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          supportRequestId: parsed.requestId,
          id: { in: [parsed.supersededHandoffId, parsed.replacementHandoffId] },
        },
        select: {
          id: true,
          requestVersion: true,
          supersessionAsPrior: { select: { id: true } },
          venuePackage: {
            select: {
              id: true,
              status: true,
              updatedAt: true,
              payloadHash: true,
              appliedAt: true,
              appliedBy: true,
              appliedCommandKey: true,
              revertedAt: true,
              revertedBy: true,
              revertedCommandKey: true,
            },
          },
        },
      }),
    ])
    if (!run) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'FORBIDDEN',
        'Running package-reconciliation agent run is not in scope.',
      )
    }
    if (!request) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'NOT_FOUND',
        'Support request was not found.',
      )
    }
    if (
      request.version !== parsed.expectedVersion ||
      !['OPEN', 'IN_REVIEW'].includes(request.status)
    ) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'CONFLICT',
        'Support request changed or is not active; refresh supersession evidence.',
      )
    }
    const superseded = handoffs.find((item) => item.id === parsed.supersededHandoffId)
    const replacement = handoffs.find((item) => item.id === parsed.replacementHandoffId)
    if (!superseded || !replacement) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'NOT_FOUND',
        'Exact support package handoffs were not found.',
      )
    }
    if (
      superseded.supersessionAsPrior ||
      superseded.venuePackage.status !== 'REVERTED' ||
      !superseded.venuePackage.revertedAt ||
      !superseded.venuePackage.revertedBy ||
      !superseded.venuePackage.revertedCommandKey
    ) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'CONFLICT',
        'The historical handoff is not an unsuperseded reverted package.',
      )
    }
    if (
      replacement.venuePackage.status !== 'APPLIED' ||
      !replacement.venuePackage.appliedAt ||
      !replacement.venuePackage.appliedBy ||
      !replacement.venuePackage.appliedCommandKey
    ) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'CONFLICT',
        'The replacement handoff is not a fully applied package.',
      )
    }
    const snapshot = SupportPackageHandoffSupersessionProposalSnapshot.parse({
      contractVersion: 1,
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      requestId: request.id,
      expectedVersion: request.version,
      supportRequestStatus: request.status,
      superseded: {
        handoffId: superseded.id,
        packageId: superseded.venuePackage.id,
        handoffRequestVersion: superseded.requestVersion,
        packageUpdatedAt: superseded.venuePackage.updatedAt.toISOString(),
        payloadHash: superseded.venuePackage.payloadHash,
        revertedAt: superseded.venuePackage.revertedAt.toISOString(),
        revertedBy: superseded.venuePackage.revertedBy,
        revertedCommandKey: superseded.venuePackage.revertedCommandKey,
      },
      replacement: {
        handoffId: replacement.id,
        packageId: replacement.venuePackage.id,
        handoffRequestVersion: replacement.requestVersion,
        packageUpdatedAt: replacement.venuePackage.updatedAt.toISOString(),
        payloadHash: replacement.venuePackage.payloadHash,
        appliedAt: replacement.venuePackage.appliedAt.toISOString(),
        appliedBy: replacement.venuePackage.appliedBy,
        appliedCommandKey: replacement.venuePackage.appliedCommandKey,
      },
      historicalHandoffPreserved: true,
      replacementAlreadyApplied: true,
      packageLifecycleChanged: false,
      supportRequestChanged: false,
      supportStatusChanged: false,
      clientActivityChanged: false,
      customerContacted: false,
      externalDeliveryTriggered: false,
      executionAuthorized: false,
    })
    const approvalRequest = await tx.approvalRequest.create({
      data: {
        id: parsed.operationId,
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        agentIdentityId: identity.id,
        agentRunId: run.id,
        requestedByType: 'AGENT',
        requestedById: identity.id,
        proposedAction: SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION,
        scopeSnapshot: snapshot,
        reason: parsed.reason,
        riskCategory: 'MEDIUM',
        artifacts: parsed.evidence,
      },
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        agentIdentityId: true,
        agentRunId: true,
        proposedAction: true,
        scopeSnapshot: true,
        reason: true,
        createdAt: true,
      },
    })
    const action = await tx.agentAction.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        agentRunId: run.id,
        agentIdentityId: identity.id,
        actorType: 'AGENT',
        actorId: identity.id,
        requestedOperation: run.requestedOperation,
        actionName: 'torchiko.support.propose_package_handoff_supersession',
        inputSummary: `Reconcile reverted package ${snapshot.superseded.packageId} to applied replacement ${snapshot.replacement.packageId}.`,
        inputReference: `SupportRequest:${request.id}:v${request.version}`,
        output: {
          approvalRequestId: approvalRequest.id,
          supersededHandoffId: snapshot.superseded.handoffId,
          replacementHandoffId: snapshot.replacement.handoffId,
        },
        modelProvider: parsed.actor.modelProvider ?? null,
        modelName: parsed.actor.modelName ?? null,
        status: 'SUCCEEDED',
        beforeVersionRef: `SupportRequest:${request.id}:v${request.version}`,
        afterVersionRef: `ApprovalRequest:${approvalRequest.id}:PENDING`,
      },
      select: { id: true },
    })
    const transitioned = await tx.agentRun.updateMany({
      where: { id: run.id, tenantId: parsed.tenantId, venueId: parsed.venueId, status: 'RUNNING' },
      data: { status: 'AWAITING_APPROVAL' },
    })
    if (transitioned.count !== 1) {
      throw new SupportPackageHandoffSupersessionProposalError(
        'CONFLICT',
        'Agent run changed before supersession review was recorded.',
      )
    }
    await tx.agentTimelineEvent.create({
      data: {
        tenantId: parsed.tenantId,
        venueId: parsed.venueId,
        agentRunId: run.id,
        agentActionId: action.id,
        actorType: 'AGENT',
        actorId: identity.id,
        eventType: 'support-package-handoff-supersession.awaiting-approval',
        message: 'A reverted package handoff and its applied replacement need founder review.',
        data: {
          approvalRequestId: approvalRequest.id,
          requestId: request.id,
          supersededHandoffId: snapshot.superseded.handoffId,
          replacementHandoffId: snapshot.replacement.handoffId,
        },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actor: parsed.actor,
        action: 'support-request.package-handoff-supersession-proposed',
        targetType: 'ApprovalRequest',
        targetId: approvalRequest.id,
        sourceReferences: parsed.evidence,
        structuredReason: {
          requestId: request.id,
          supersededHandoffId: snapshot.superseded.handoffId,
          replacementHandoffId: snapshot.replacement.handoffId,
        },
        afterState: {
          status: 'PENDING',
          historicalHandoffPreserved: true,
          packageLifecycleChanged: false,
          supportRequestChanged: false,
          customerContacted: false,
          executionAuthorized: false,
        },
      },
      tx,
    )
    return { approvalRequest, snapshot, replayed: false as const }
  })
}
