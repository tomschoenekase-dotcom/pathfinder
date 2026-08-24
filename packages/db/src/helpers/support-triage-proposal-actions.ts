import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'
import { SupportRequestCategory } from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { normalizeSupportMissingInformation } from './support-triage-actions'

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()

const proposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'support:triage') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact support:triage capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Support triage proposals require an idempotency key.',
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
    category: SupportRequestCategory,
    missingInformation: z.array(z.string()).max(30),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(10).default([]),
    actor: proposalActor,
  })
  .strict()

export type PrepareSupportTriageProposalInput = z.input<typeof inputSchema>
export type SupportTriageProposalActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class SupportTriageProposalActionError extends Error {
  constructor(
    readonly code: SupportTriageProposalActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SupportTriageProposalActionError'
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
 * Prepares structured support triage for human review. This records approval and
 * agent evidence only; it never mutates the request, client activity, messages,
 * participants, status, or package lifecycle.
 */
export async function prepareSupportTriageProposalAction(
  input: PrepareSupportTriageProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new SupportTriageProposalActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Support triage proposal input is invalid.',
    )
  }
  const parsed = parsedResult.data
  let missingInformation: string[]
  try {
    missingInformation = normalizeSupportMissingInformation(parsed.missingInformation)
  } catch (error) {
    throw new SupportTriageProposalActionError(
      'INVALID_INPUT',
      error instanceof Error ? error.message : 'Support triage proposal is invalid.',
    )
  }
  const snapshot = {
    contractVersion: 1 as const,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    requestId: parsed.requestId,
    expectedVersion: parsed.expectedVersion,
    proposedCategory: parsed.category,
    proposedMissingInformation: missingInformation,
    supportRequestChanged: false as const,
    clientActivityChanged: false as const,
    customerContacted: false as const,
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
          existing.proposedAction !== 'torchiko.support.triage' ||
          existing.reason !== parsed.reason ||
          !exactJson(existing.scopeSnapshot, snapshot) ||
          !exactJson(existing.artifacts, parsed.evidence)
        ) {
          throw new SupportTriageProposalActionError(
            'CONFLICT',
            'Support triage proposal operation ID was already used for different content or scope.',
          )
        }
        return { approvalRequest: existing, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: 'support:triage' },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new SupportTriageProposalActionError(
          'FORBIDDEN',
          'Enabled support-triage agent identity is not in scope.',
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
          where: {
            id: parsed.requestId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
          },
          select: { id: true, version: true, status: true },
        }),
      ])
      if (!run) {
        throw new SupportTriageProposalActionError(
          'FORBIDDEN',
          'Running support-triage agent run is not in scope.',
        )
      }
      if (!request) {
        throw new SupportTriageProposalActionError('NOT_FOUND', 'Support request was not found.')
      }
      if (request.status === 'COMPLETED' || request.status === 'CANCELLED') {
        throw new SupportTriageProposalActionError(
          'CONFLICT',
          'Closed support requests cannot receive triage proposals.',
        )
      }
      if (request.version !== parsed.expectedVersion) {
        throw new SupportTriageProposalActionError(
          'CONFLICT',
          'Support request changed; refresh it before proposing triage.',
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
          proposedAction: 'torchiko.support.triage',
          scopeSnapshot: snapshot,
          reason: parsed.reason,
          riskCategory: 'LOW',
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
          actionName: 'torchiko.support.propose_triage',
          inputSummary: `Prepare triage recommendation for support request ${request.id}.`,
          inputReference: `SupportRequest:${request.id}:v${request.version}`,
          output: {
            approvalRequestId: approvalRequest.id,
            proposedAction: approvalRequest.proposedAction,
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
        throw new SupportTriageProposalActionError(
          'CONFLICT',
          'Agent run changed before the support triage proposal was recorded.',
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
          eventType: 'support-triage.awaiting-approval',
          message: 'A structured support triage recommendation is waiting for human review.',
          data: {
            approvalRequestId: approvalRequest.id,
            requestId: request.id,
            expectedVersion: request.version,
            supportRequestChanged: false,
          },
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'support-request.triage-proposed',
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
            customerContacted: false,
            executionAuthorized: false,
          },
        },
        tx,
      )

      return { approvalRequest, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof SupportTriageProposalActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new SupportTriageProposalActionError(
        'CONFLICT',
        'A support triage proposal already exists for this operation.',
      )
    }
    throw error
  }
}
