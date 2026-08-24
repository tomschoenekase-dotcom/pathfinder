import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
  SUPPORT_PACKAGE_DRAFT_CAPABILITY,
  SupportPackageDraftApplyParameters,
} from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()

const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== SUPPORT_PACKAGE_DRAFT_CAPABILITY) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact packages:draft capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support package-draft proposals require an idempotency key.',
    })
  }
  if ((actor.modelProvider === undefined) !== (actor.modelName === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['modelProvider'],
      message: 'Model provider and model name must be supplied together.',
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
    fromStatus: z.enum(['OPEN', 'IN_REVIEW']),
    draftKey: z.string().uuid(),
    payload: z.record(z.unknown()),
    operationCounts: SupportPackageDraftApplyParameters.shape.operationCounts,
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(20).default([]),
    actor: proposalActor,
  })
  .strict()

export type PrepareSupportPackageDraftProposalInput = z.input<typeof inputSchema>
export type SupportPackageDraftProposalActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class SupportPackageDraftProposalActionError extends Error {
  constructor(
    readonly code: SupportPackageDraftProposalActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupportPackageDraftProposalActionError'
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

export function supportPackageDraftPayloadHash(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex')
}

function exactJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

/** Prepares one exact V3 package DRAFT and support-request link for founder review.
 * It creates no package, handoff, support change, message, contact, or external effect. */
export async function prepareSupportPackageDraftProposalAction(
  input: PrepareSupportPackageDraftProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportPackageDraftProposalActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support package-draft proposal is invalid.',
    )
  }
  const parsed = parsedResult.data
  const proposalPayloadHash = supportPackageDraftPayloadHash(parsed.payload)
  const snapshot = {
    contractVersion: 1 as const,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    requestId: parsed.requestId,
    expectedVersion: parsed.expectedVersion,
    fromStatus: parsed.fromStatus,
    draftKey: parsed.draftKey,
    payload: parsed.payload,
    proposalPayloadHash,
    operationCounts: parsed.operationCounts,
    missingInformationCount: 0 as const,
    packageDraftCreated: false as const,
    packageLinked: false as const,
    packageApproved: false as const,
    packageApplied: false as const,
    packagePublished: false as const,
    supportRequestChanged: false as const,
    clientActivityChanged: false as const,
    customerContacted: false as const,
    externalDeliveryTriggered: false as const,
    executionAuthorized: false as const,
  }

  try {
    return await client.$transaction(async (tx) => {
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
          decision: { select: { decision: true } },
        },
      })
      if (existing) {
        if (
          existing.tenantId !== parsed.tenantId ||
          existing.venueId !== parsed.venueId ||
          existing.agentIdentityId !== parsed.actor.agentIdentityId ||
          existing.agentRunId !== parsed.actor.agentRunId ||
          existing.proposedAction !== SUPPORT_PACKAGE_DRAFT_APPLY_ACTION ||
          existing.reason !== parsed.reason ||
          !exactJson(existing.scopeSnapshot, snapshot) ||
          !exactJson(existing.artifacts, parsed.evidence)
        ) {
          throw new SupportPackageDraftProposalActionError(
            'CONFLICT',
            'Support package-draft proposal operation ID was already used.',
          )
        }
        return { approvalRequest: existing, proposalPayloadHash, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: SUPPORT_PACKAGE_DRAFT_CAPABILITY },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new SupportPackageDraftProposalActionError(
          'FORBIDDEN',
          'Enabled package-draft agent identity is not in scope.',
        )
      }

      const [run, request] = await Promise.all([
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
          select: { id: true, version: true, status: true, missingInformation: true },
        }),
      ])
      if (!run) {
        throw new SupportPackageDraftProposalActionError(
          'FORBIDDEN',
          'Running package-draft agent run is not in scope.',
        )
      }
      if (!request) {
        throw new SupportPackageDraftProposalActionError(
          'NOT_FOUND',
          'Support request was not found.',
        )
      }
      if (request.version !== parsed.expectedVersion || request.status !== parsed.fromStatus) {
        throw new SupportPackageDraftProposalActionError(
          'CONFLICT',
          'Support request changed; refresh it before proposing a package draft.',
        )
      }
      if (request.missingInformation.length > 0) {
        throw new SupportPackageDraftProposalActionError(
          'CONFLICT',
          'Requested information must be resolved before a package draft can be proposed.',
        )
      }

      const approvalRequest = await tx.approvalRequest.create({
        data: {
          id: parsed.operationId,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          agentIdentityId: identity.id,
          agentRunId: run.id,
          requestedByType: 'AGENT',
          requestedById: identity.id,
          proposedAction: SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
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
          actionName: 'torchiko.support.propose_package_draft',
          inputSummary: `Prepare a ${parsed.operationCounts.total}-operation V3 package draft for support request ${request.id}.`,
          inputReference: `SupportRequest:${request.id}:v${request.version}`,
          output: {
            approvalRequestId: approvalRequest.id,
            proposedAction: approvalRequest.proposedAction,
            proposalPayloadHash,
            packageDraftCreated: false,
            supportRequestChanged: false,
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
        where: {
          id: run.id,
          tenantId: parsed.tenantId,
          venueId: parsed.venueId,
          status: 'RUNNING',
        },
        data: { status: 'AWAITING_APPROVAL' },
      })
      if (transitioned.count !== 1) {
        throw new SupportPackageDraftProposalActionError(
          'CONFLICT',
          'Agent run changed before the package-draft proposal was recorded.',
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
          eventType: 'support-package-draft.awaiting-approval',
          message: 'A granular support package DRAFT is waiting for human review.',
          data: {
            approvalRequestId: approvalRequest.id,
            requestId: request.id,
            expectedVersion: request.version,
            proposalPayloadHash,
            operationCounts: parsed.operationCounts,
            packageDraftCreated: false,
          },
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'support-request.package-draft-proposed',
          targetType: 'ApprovalRequest',
          targetId: approvalRequest.id,
          sourceReferences: parsed.evidence,
          structuredReason: {
            proposedAction: approvalRequest.proposedAction,
            requestId: request.id,
            proposalPayloadHash,
          },
          afterState: {
            status: 'PENDING',
            operationCounts: parsed.operationCounts,
            packageDraftCreated: false,
            packageLinked: false,
            packageApproved: false,
            packageApplied: false,
            packagePublished: false,
            supportRequestChanged: false,
            customerContacted: false,
            externalDeliveryTriggered: false,
            executionAuthorized: false,
          },
        },
        tx,
      )
      return { approvalRequest, proposalPayloadHash, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof SupportPackageDraftProposalActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new SupportPackageDraftProposalActionError(
        'CONFLICT',
        'A support package-draft proposal already exists for this operation.',
      )
    }
    throw error
  }
}
