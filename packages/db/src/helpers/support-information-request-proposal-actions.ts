import { z } from 'zod'

import { SUPPORT_INFORMATION_REQUEST_APPLY_ACTION } from '@pathfinder/contracts'
import { MachineActorContext } from '@pathfinder/contracts/actor'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { normalizeSupportMissingInformation } from './support-triage-actions'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()

const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'support:request-information') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact support:request-information capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support information-request proposals require an idempotency key.',
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
    body: z.string().trim().min(1).max(20_000),
    missingInformation: z.array(z.string()).min(1).max(30),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(10).default([]),
    actor: proposalActor,
  })
  .strict()

export type PrepareSupportInformationRequestProposalInput = z.input<typeof inputSchema>
export type SupportInformationRequestProposalActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class SupportInformationRequestProposalActionError extends Error {
  constructor(
    readonly code: SupportInformationRequestProposalActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupportInformationRequestProposalActionError'
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

/**
 * Prepares one deliberate in-app information request for founder review. It
 * records proposal and agent evidence only; no message, status, client activity,
 * external delivery, participant, triage, or package state is changed.
 */
export async function prepareSupportInformationRequestProposalAction(
  input: PrepareSupportInformationRequestProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportInformationRequestProposalActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support information-request proposal is invalid.',
    )
  }
  const parsed = parsedResult.data
  let missingInformation: string[]
  try {
    missingInformation = normalizeSupportMissingInformation(parsed.missingInformation)
  } catch (error) {
    throw new SupportInformationRequestProposalActionError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : 'Missing-information checklist is invalid.',
    )
  }
  const snapshot = {
    contractVersion: 1 as const,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    requestId: parsed.requestId,
    expectedVersion: parsed.expectedVersion,
    fromStatus: parsed.fromStatus,
    toStatus: 'WAITING_FOR_CLIENT' as const,
    body: parsed.body,
    missingInformation,
    supportRequestChanged: false as const,
    clientActivityChanged: false as const,
    clientVisibleMessageCreated: false as const,
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
          existing.proposedAction !== SUPPORT_INFORMATION_REQUEST_APPLY_ACTION ||
          existing.reason !== parsed.reason ||
          !exactJson(existing.scopeSnapshot, snapshot) ||
          !exactJson(existing.artifacts, parsed.evidence)
        ) {
          throw new SupportInformationRequestProposalActionError(
            'CONFLICT',
            'Support information-request proposal operation ID was already used.',
          )
        }
        return { approvalRequest: existing, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: 'support:request-information' },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new SupportInformationRequestProposalActionError(
          'FORBIDDEN',
          'Enabled support-information agent identity is not in scope.',
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
        throw new SupportInformationRequestProposalActionError(
          'FORBIDDEN',
          'Running support-information agent run is not in scope.',
        )
      }
      if (!request) {
        throw new SupportInformationRequestProposalActionError(
          'NOT_FOUND',
          'Support request was not found.',
        )
      }
      if (request.version !== parsed.expectedVersion || request.status !== parsed.fromStatus) {
        throw new SupportInformationRequestProposalActionError(
          'CONFLICT',
          'Support request changed; refresh it before proposing client contact.',
        )
      }
      if (request.missingInformation.length === 0) {
        throw new SupportInformationRequestProposalActionError(
          'CONFLICT',
          'Support request has no missing-information checklist.',
        )
      }
      if (!exactJson(request.missingInformation, missingInformation)) {
        throw new SupportInformationRequestProposalActionError(
          'CONFLICT',
          'The proposed checklist must exactly match current support triage.',
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
          proposedAction: SUPPORT_INFORMATION_REQUEST_APPLY_ACTION,
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
          actionName: 'torchiko.support.propose_information_request',
          inputSummary: `Prepare a client information prompt for support request ${request.id}.`,
          inputReference: `SupportRequest:${request.id}:v${request.version}`,
          output: {
            approvalRequestId: approvalRequest.id,
            proposedAction: approvalRequest.proposedAction,
            supportRequestChanged: false,
            customerContacted: false,
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
        throw new SupportInformationRequestProposalActionError(
          'CONFLICT',
          'Agent run changed before the information-request proposal was recorded.',
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
          eventType: 'support-information-request.awaiting-approval',
          message: 'A client-visible support information request is waiting for human review.',
          data: {
            approvalRequestId: approvalRequest.id,
            requestId: request.id,
            expectedVersion: request.version,
            customerContacted: false,
          },
        },
      })
      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'support-request.information-request-proposed',
          targetType: 'ApprovalRequest',
          targetId: approvalRequest.id,
          sourceReferences: parsed.evidence,
          structuredReason: {
            proposedAction: approvalRequest.proposedAction,
            requestId: request.id,
          },
          afterState: {
            status: 'PENDING',
            supportRequestChanged: false,
            clientActivityChanged: false,
            clientVisibleMessageCreated: false,
            customerContacted: false,
            externalDeliveryTriggered: false,
            executionAuthorized: false,
          },
        },
        tx,
      )
      return { approvalRequest, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof SupportInformationRequestProposalActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new SupportInformationRequestProposalActionError(
        'CONFLICT',
        'A support information-request proposal already exists for this operation.',
      )
    }
    throw error
  }
}
