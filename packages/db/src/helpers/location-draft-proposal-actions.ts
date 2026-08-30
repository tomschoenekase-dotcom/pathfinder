import { z } from 'zod'

import { MachineActorContext } from '@pathfinder/contracts/actor'
import { VenueLocationDraftFieldsSchema } from '@pathfinder/contracts/location-authoring'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

const locationProposalActor = MachineActorContext.superRefine((actor, context) => {
  if (actor.capability !== 'locations:propose') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: 'The exact locations:propose capability is required.',
    })
  }
  if (!actor.idempotencyKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['idempotencyKey'],
      message: 'Location proposals require an idempotency key.',
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

const evidenceReference = z
  .object({ type: z.string().trim().min(1).max(100), id: z.string().trim().min(1).max(191) })
  .strict()

const inputSchema = z
  .object({
    operationId: z.string().uuid(),
    tenantId: z.string().trim().min(1).max(191),
    venueId: z.string().trim().min(1).max(191),
    reason: z.string().trim().min(3).max(2000),
    evidence: z.array(evidenceReference).max(10).default([]),
    draft: VenueLocationDraftFieldsSchema,
    actor: locationProposalActor,
  })
  .strict()

export type PrepareLocationDraftProposalInput = z.input<typeof inputSchema>
export type LocationDraftProposalActionErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'

export class LocationDraftProposalActionError extends Error {
  constructor(
    readonly code: LocationDraftProposalActionErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocationDraftProposalActionError'
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  )
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Prepares one typed location draft for human review. This writes approval and
 * agent evidence only; it never creates, edits, activates, or publishes a location.
 */
export async function prepareLocationDraftProposalAction(
  input: PrepareLocationDraftProposalInput,
  client: Pick<typeof db, '$transaction'> = db,
) {
  const parsedResult = inputSchema.safeParse(input)
  if (!parsedResult.success) {
    throw new LocationDraftProposalActionError(
      'INVALID_INPUT',
      parsedResult.error.issues[0]?.message ?? 'Location proposal input is invalid.',
    )
  }
  const parsed = parsedResult.data
  const snapshot = {
    contractVersion: 1 as const,
    tenantId: parsed.tenantId,
    venueId: parsed.venueId,
    draft: parsed.draft,
    canonicalVenueContentChanged: false as const,
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
          existing.proposedAction !== 'torchiko.locations.create_draft' ||
          existing.reason !== parsed.reason ||
          !exactJson(existing.scopeSnapshot, snapshot) ||
          !exactJson(existing.artifacts, parsed.evidence)
        ) {
          throw new LocationDraftProposalActionError(
            'CONFLICT',
            'Location proposal operation ID was already used for different content or scope.',
          )
        }
        return { approvalRequest: existing, replayed: true as const }
      }

      const identity = await tx.agentIdentity.findFirst({
        where: {
          id: parsed.actor.agentIdentityId,
          tenantId: parsed.tenantId,
          enabled: true,
          accessCapabilities: { has: 'locations:propose' },
          OR: [
            { accessScope: { in: ['CLIENT', 'PLATFORM'] } },
            { accessScope: 'VENUE', venueId: parsed.venueId },
          ],
        },
        select: { id: true },
      })
      if (!identity) {
        throw new LocationDraftProposalActionError(
          'FORBIDDEN',
          'Enabled location-proposal agent identity is not in scope.',
        )
      }

      const [run, venue] = await Promise.all([
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
        tx.venue.findFirst({
          where: { id: parsed.venueId, tenantId: parsed.tenantId },
          select: { id: true },
        }),
      ])
      if (!run) {
        throw new LocationDraftProposalActionError(
          'FORBIDDEN',
          'Running location-proposal agent run is not in scope.',
        )
      }
      if (!venue) throw new LocationDraftProposalActionError('NOT_FOUND', 'Venue was not found.')

      if (parsed.draft.floorId) {
        const floor = await tx.venueFloor.findFirst({
          where: {
            id: parsed.draft.floorId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            isActive: true,
          },
          select: { id: true },
        })
        if (!floor) {
          throw new LocationDraftProposalActionError('NOT_FOUND', 'Active floor was not found.')
        }
      }
      if (parsed.draft.parentLocationId) {
        const parent = await tx.venueLocation.findFirst({
          where: {
            id: parsed.draft.parentLocationId,
            tenantId: parsed.tenantId,
            venueId: parsed.venueId,
            isActive: true,
          },
          select: { id: true },
        })
        if (!parent) {
          throw new LocationDraftProposalActionError(
            'NOT_FOUND',
            'Active parent location was not found.',
          )
        }
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
          proposedAction: 'torchiko.locations.create_draft',
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
          actionName: 'torchiko.locations.propose_draft',
          inputSummary: `Prepare inactive location draft “${parsed.draft.displayName}” for human review.`,
          inputReference: `ApprovalRequest:${approvalRequest.id}`,
          output: {
            approvalRequestId: approvalRequest.id,
            proposedAction: approvalRequest.proposedAction,
            canonicalVenueContentChanged: false,
          },
          modelProvider: parsed.actor.modelProvider ?? null,
          modelName: parsed.actor.modelName ?? null,
          status: 'SUCCEEDED',
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
        throw new LocationDraftProposalActionError(
          'CONFLICT',
          'Agent run changed before the location proposal was recorded.',
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
          eventType: 'location-draft.awaiting-approval',
          message: 'A typed inactive location draft is waiting for human review.',
          data: {
            approvalRequestId: approvalRequest.id,
            stableKey: parsed.draft.stableKey,
            canonicalVenueContentChanged: false,
          },
        },
      })

      await writeAuditLogStrict(
        {
          tenantId: parsed.tenantId,
          actor: parsed.actor,
          action: 'venue-location.draft-proposed',
          targetType: 'ApprovalRequest',
          targetId: approvalRequest.id,
          sourceReferences: parsed.evidence,
          structuredReason: {
            proposedAction: approvalRequest.proposedAction,
            stableKey: parsed.draft.stableKey,
          },
          afterState: {
            status: 'PENDING',
            canonicalVenueContentChanged: false,
          },
        },
        tx,
      )

      return { approvalRequest, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof LocationDraftProposalActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new LocationDraftProposalActionError(
        'CONFLICT',
        'A location proposal already exists for this operation.',
      )
    }
    throw error
  }
}
