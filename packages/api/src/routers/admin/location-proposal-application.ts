import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  LocationDraftProposalSnapshotSchema,
  VenueLocationDraftFieldsSchema,
} from '@pathfinder/contracts/location-authoring'
import {
  db,
  lockVenueContentMutation,
  withTenantIsolationBypass,
  writeAuditLogStrict,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  exactCreateReplay,
  isUniqueConflict,
  locationAuthoringScope,
  projectLocation,
  validateLocationRelations,
} from './location-authoring-contract'

export const adminLocationAuthoringApplicationRouter = router({
  applyApprovedVenueLocationDraft: adminProcedure
    .input(
      z
        .object({
          ...locationAuthoringScope,
          approvalRequestId: z.string().uuid(),
          expectedDecisionAt: z.coerce.date(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          db.$transaction(async (tx) => {
            await lockVenueContentMutation(tx, input)
            const request = await tx.approvalRequest.findFirst({
              where: {
                id: input.approvalRequestId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                proposedAction: 'torchiko.locations.create_draft',
              },
              select: {
                id: true,
                agentIdentityId: true,
                agentRunId: true,
                scopeSnapshot: true,
                agentRun: { select: { requestedOperation: true } },
                decision: {
                  select: {
                    id: true,
                    decision: true,
                    decidedByType: true,
                    createdAt: true,
                    resultingAction: { select: { id: true, status: true, inputSummary: true } },
                  },
                },
              },
            })
            if (!request) {
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Location proposal not found.' })
            }
            const decision = request.decision
            if (
              !decision ||
              decision.decision !== 'APPROVED' ||
              decision.decidedByType !== 'HUMAN'
            ) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'A current human approval is required before creating the draft.',
              })
            }
            if (decision.createdAt.getTime() !== input.expectedDecisionAt.getTime()) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Approval evidence changed; refresh before applying.',
              })
            }
            const parsed = LocationDraftProposalSnapshotSchema.safeParse(request.scopeSnapshot)
            if (!parsed.success) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'The proposal payload is not a supported location draft contract.',
              })
            }
            if (parsed.data.tenantId !== input.tenantId || parsed.data.venueId !== input.venueId) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'The proposal payload does not match the approved tenant and venue.',
              })
            }
            const draft = VenueLocationDraftFieldsSchema.parse(parsed.data.draft)
            if (decision.resultingAction) {
              const replay = await tx.venueLocation.findFirst({
                where: { id: request.id, tenantId: input.tenantId, venueId: input.venueId },
              })
              if (
                decision.resultingAction.status !== 'SUCCEEDED' ||
                decision.resultingAction.inputSummary !== input.reason ||
                !replay ||
                !exactCreateReplay(projectLocation(replay), {
                  operationId: request.id,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  ...draft,
                })
              ) {
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Approved proposal application evidence is inconsistent.',
                })
              }
              return { location: projectLocation(replay), replayed: true }
            }
            if (!request.agentRunId || !request.agentRun) {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'The proposal is missing its originating agent run.',
              })
            }
            await validateLocationRelations(tx, {
              tenantId: input.tenantId,
              venueId: input.venueId,
              floorId: draft.floorId,
              parentLocationId: draft.parentLocationId,
            })
            const now = new Date()
            const created = await tx.venueLocation.create({
              data: {
                id: request.id,
                tenantId: input.tenantId,
                venueId: input.venueId,
                stableKey: draft.stableKey,
                kind: draft.kind,
                displayName: draft.displayName,
                description: draft.description,
                visibility: draft.visibility,
                floorId: draft.floorId,
                parentLocationId: draft.parentLocationId,
                latitude: draft.coordinates?.latitude ?? null,
                longitude: draft.coordinates?.longitude ?? null,
                mapX: draft.mapAnchor?.x ?? null,
                mapY: draft.mapAnchor?.y ?? null,
                externalMapReference: draft.externalMapReference,
                accessibilityMetadata: draft.accessibilityMetadata,
                verifiedAt: now,
                verifiedBy: ctx.session.userId,
                isActive: false,
              },
            })
            const action = await tx.agentAction.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentRunId: request.agentRunId,
                agentIdentityId: request.agentIdentityId,
                approvalDecisionId: decision.id,
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                requestedOperation: request.agentRun.requestedOperation,
                actionName: 'torchiko.locations.apply_approved_draft',
                inputSummary: input.reason,
                inputReference: `ApprovalRequest:${request.id}`,
                output: {
                  locationId: created.id,
                  status: 'INACTIVE_DRAFT',
                  activationRequired: true,
                },
                status: 'SUCCEEDED',
                beforeVersionRef: `ApprovalRequest:${request.id}:APPROVED`,
                afterVersionRef: `VenueLocation:${created.id}:INACTIVE`,
              },
              select: { id: true },
            })
            await tx.agentTimelineEvent.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentRunId: request.agentRunId,
                agentActionId: action.id,
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                eventType: 'location-draft.applied',
                message: 'Approved proposal was applied as an inactive location draft.',
                data: { approvalRequestId: request.id, locationId: created.id, isActive: false },
              },
            })
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'venue-location.approved-draft-applied',
                targetType: 'VenueLocation',
                targetId: created.id,
                sourceReferences: [{ type: 'ApprovalRequest', id: request.id }],
                afterState: {
                  stableKey: draft.stableKey,
                  isActive: false,
                  approvalDecisionId: decision.id,
                  reason: input.reason,
                },
              },
              tx,
            )
            return { location: projectLocation(created), replayed: false }
          }),
        )
      } catch (error) {
        if (isUniqueConflict(error)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Stable key is already in use.' })
        }
        throw error
      }
    }),
})
