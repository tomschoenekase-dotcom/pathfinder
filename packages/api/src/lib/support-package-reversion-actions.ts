import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_REVERSION_APPLY_ACTION,
  SUPPORT_PACKAGE_REVERSION_CAPABILITY,
  SupportPackageReversionProposalSnapshot,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'
import { db, writeAuditLogStrict } from '@pathfinder/db'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()
const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== SUPPORT_PACKAGE_REVERSION_CAPABILITY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact packages:revert capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support package-reversion proposals require an idempotency key.',
    })
  }
})
const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    packageId: z.string().trim().min(1).max(191),
    expectedUpdatedAt: z.coerce.date(),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(20).default([]),
    actor: proposalActor,
  })
  .strict()

export type PrepareSupportPackageReversionProposalInput = z.input<typeof inputSchema>
export class SupportPackageReversionProposalError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'FORBIDDEN' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageReversionProposalError'
  }
}

function canonicalJson(current: unknown): string {
  if (Array.isArray(current)) return `[${current.map(canonicalJson).join(',')}]`
  if (current !== null && typeof current === 'object') {
    return `{${Object.entries(current as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(current)
}

export function supportPackageRollbackManifestDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Freezes one exact APPLIED support-linked package for founder rollback review.
 * It deliberately excludes completed support requests and mutates no content. */
export async function prepareSupportPackageReversionProposalAction(
  input: PrepareSupportPackageReversionProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageReversionProposalError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support package-reversion proposal is invalid.',
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
      const snapshot = SupportPackageReversionProposalSnapshot.safeParse(existing.scopeSnapshot)
      if (
        existing.tenantId !== parsed.tenantId ||
        existing.venueId !== parsed.venueId ||
        existing.agentIdentityId !== parsed.actor.agentIdentityId ||
        existing.agentRunId !== parsed.actor.agentRunId ||
        existing.proposedAction !== SUPPORT_PACKAGE_REVERSION_APPLY_ACTION ||
        existing.reason !== parsed.reason ||
        !snapshot.success ||
        snapshot.data.packageId !== parsed.packageId ||
        snapshot.data.expectedUpdatedAt !== parsed.expectedUpdatedAt.toISOString() ||
        canonicalJson(existing.artifacts) !== canonicalJson(parsed.evidence)
      ) {
        throw new SupportPackageReversionProposalError(
          'CONFLICT',
          'Support package-reversion proposal operation ID was already used.',
        )
      }
      return { approvalRequest: existing, snapshot: snapshot.data, replayed: true as const }
    }

    const identity = await tx.agentIdentity.findFirst({
      where: {
        id: parsed.actor.agentIdentityId,
        tenantId: parsed.tenantId,
        enabled: true,
        accessCapabilities: { has: SUPPORT_PACKAGE_REVERSION_CAPABILITY },
        OR: [
          { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
          { accessScope: 'VENUE', venueId: parsed.venueId },
        ],
      },
      select: { id: true },
    })
    if (!identity) {
      throw new SupportPackageReversionProposalError(
        'FORBIDDEN',
        'Enabled package-reversion agent identity is not in scope.',
      )
    }
    const [run, pkg] = await Promise.all([
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
      tx.venuePackage.findFirst({
        where: { id: parsed.packageId, tenantId: parsed.tenantId, venueId: parsed.venueId },
        select: {
          id: true,
          status: true,
          updatedAt: true,
          payloadHash: true,
          baseDigest: true,
          appliedEntities: true,
          appliedAt: true,
          appliedBy: true,
          appliedCommandKey: true,
          supportHandoffs: {
            take: 1,
            select: {
              id: true,
              supportRequestId: true,
              requestVersion: true,
              supportRequest: { select: { version: true, status: true } },
            },
          },
        },
      }),
    ])
    if (!run) {
      throw new SupportPackageReversionProposalError(
        'FORBIDDEN',
        'Running package-reversion agent run is not in scope.',
      )
    }
    if (!pkg)
      throw new SupportPackageReversionProposalError('NOT_FOUND', 'Venue package not found.')
    if (
      pkg.status !== 'APPLIED' ||
      pkg.updatedAt.getTime() !== parsed.expectedUpdatedAt.getTime() ||
      !pkg.appliedEntities ||
      !pkg.appliedAt ||
      !pkg.appliedBy ||
      !pkg.appliedCommandKey
    ) {
      throw new SupportPackageReversionProposalError(
        'CONFLICT',
        'Venue package is not the expected applied revision with rollback evidence.',
      )
    }
    const handoff = pkg.supportHandoffs[0]
    if (!handoff) {
      throw new SupportPackageReversionProposalError(
        'CONFLICT',
        'Only a support-linked package can use this reversion workflow.',
      )
    }
    if (!['OPEN', 'IN_REVIEW'].includes(handoff.supportRequest.status)) {
      throw new SupportPackageReversionProposalError(
        'CONFLICT',
        'Agent package reversion requires an active support request; completed-case correction remains a separate human workflow.',
      )
    }
    const snapshot = SupportPackageReversionProposalSnapshot.parse({
      contractVersion: 1,
      tenantId: parsed.tenantId,
      venueId: parsed.venueId,
      packageId: pkg.id,
      expectedUpdatedAt: pkg.updatedAt.toISOString(),
      fromStatus: 'APPLIED',
      toStatus: 'REVERTED',
      payloadHash: pkg.payloadHash,
      baseDigest: pkg.baseDigest,
      rollbackManifestDigest: supportPackageRollbackManifestDigest(pkg.appliedEntities),
      appliedAt: pkg.appliedAt.toISOString(),
      appliedBy: pkg.appliedBy,
      appliedCommandKey: pkg.appliedCommandKey,
      supportHandoff: {
        handoffId: handoff.id,
        supportRequestId: handoff.supportRequestId,
        supportRequestVersion: handoff.requestVersion,
      },
      supportRequestVersion: handoff.supportRequest.version,
      supportRequestStatus: handoff.supportRequest.status,
      currentContentMutation: true,
      visitorVisibleChangePossible: true,
      canonicalDriftCheckRequired: true,
      automaticRollbackPolicyApplied: false,
      supportRequestChanged: false,
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
        proposedAction: SUPPORT_PACKAGE_REVERSION_APPLY_ACTION,
        scopeSnapshot: snapshot,
        reason: parsed.reason,
        riskCategory: 'HIGH',
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
        actionName: 'torchiko.support.propose_package_reversion',
        inputSummary: `Prepare applied support-linked package ${pkg.id} for founder rollback review.`,
        inputReference: `VenuePackage:${pkg.id}:${pkg.updatedAt.toISOString()}:APPLIED`,
        output: { approvalRequestId: approvalRequest.id, packageId: pkg.id },
        modelProvider: parsed.actor.modelProvider ?? null,
        modelName: parsed.actor.modelName ?? null,
        status: 'SUCCEEDED',
        beforeVersionRef: `VenuePackage:${pkg.id}:${pkg.updatedAt.toISOString()}:APPLIED`,
        afterVersionRef: `ApprovalRequest:${approvalRequest.id}:PENDING`,
      },
      select: { id: true },
    })
    const transitioned = await tx.agentRun.updateMany({
      where: { id: run.id, tenantId: parsed.tenantId, venueId: parsed.venueId, status: 'RUNNING' },
      data: { status: 'AWAITING_APPROVAL' },
    })
    if (transitioned.count !== 1) {
      throw new SupportPackageReversionProposalError(
        'CONFLICT',
        'Agent run changed before the package-reversion proposal was recorded.',
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
        eventType: 'support-package-reversion.awaiting-approval',
        message:
          'An exact applied support-linked package is waiting for founder rollback approval.',
        data: { approvalRequestId: approvalRequest.id, packageId: pkg.id },
      },
    })
    await writeAuditLogStrict(
      {
        tenantId: parsed.tenantId,
        actor: parsed.actor,
        action: 'support-package.reversion-proposed',
        targetType: 'ApprovalRequest',
        targetId: approvalRequest.id,
        sourceReferences: parsed.evidence,
        structuredReason: {
          packageId: pkg.id,
          rollbackManifestDigest: snapshot.rollbackManifestDigest,
        },
        afterState: {
          status: 'PENDING',
          packageStatus: 'APPLIED',
          currentContentMutation: false,
          executionAuthorized: false,
        },
      },
      tx,
    )
    return { approvalRequest, snapshot, replayed: false as const }
  })
}
