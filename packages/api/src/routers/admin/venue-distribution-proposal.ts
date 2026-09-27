import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { db, normalizeVenueWebsiteOrigin, writeAuditLogStrict } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  bumpDistribution,
  distributionProposalAction,
  proposalSnapshot,
  targetInput,
} from './venue-distribution-shared'

export const venueDistributionProposalRouter = router({
  applyProposal: adminProcedure
    .input(targetInput.extend({ approvalRequestId: z.string().min(1).max(128) }).strict())
    .mutation(async ({ ctx, input }) =>
      db
        .$transaction(
          async (tx) => {
            const request = await tx.approvalRequest.findFirst({
              where: {
                id: input.approvalRequestId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                proposedAction: distributionProposalAction,
                decision: { is: null },
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
              select: {
                id: true,
                scopeSnapshot: true,
                reason: true,
                agentIdentityId: true,
                agentRunId: true,
              },
            })
            if (!request || !request.agentRunId)
              throw new TRPCError({
                code: 'NOT_FOUND',
                message: 'Pending distribution proposal not found.',
              })
            const parsed = proposalSnapshot.safeParse(request.scopeSnapshot)
            if (
              !parsed.success ||
              parsed.data.tenantId !== input.tenantId ||
              parsed.data.venueId !== input.venueId
            ) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proposal scope is invalid.' })
            }
            const venue = await tx.venue.findFirst({
              where: { id: input.venueId, tenantId: input.tenantId },
              select: { id: true },
            })
            if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
            const current = await tx.venueDistribution.findFirst({
              where: { tenantId: input.tenantId, venueId: input.venueId },
              select: { revision: true, websiteState: true, appState: true },
            })
            if ((current?.revision ?? 0) !== parsed.data.expectedRevision) {
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Distribution changed since this proposal. Review a new proposal.',
              })
            }
            const change = parsed.data.change
            let targetId = input.venueId
            let beforeState: Record<string, unknown> = { revision: current?.revision ?? 0 }
            let afterState: Record<string, unknown>
            if (change.kind === 'ADD_ORIGIN') {
              const origin = normalizeVenueWebsiteOrigin(change.origin)
              if (origin !== change.origin)
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proposal origin is invalid.' })
              // Revision bump/upsert serializes all distribution writers before the
              // cap check. A failed cap check rolls the revision bump back with tx.
              const bumped = await bumpDistribution(tx, {
                tenantId: input.tenantId,
                venueId: input.venueId,
                actorId: ctx.session.userId,
              })
              const count = await tx.venueWebsiteOrigin.count({
                where: { tenantId: input.tenantId, venueId: input.venueId, state: 'ACTIVE' },
              })
              if (count >= 20)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'The venue already has 20 active origins.',
                })
              const duplicate = await tx.venueWebsiteOrigin.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  origin,
                  state: 'ACTIVE',
                },
                select: { id: true },
              })
              if (duplicate)
                throw new TRPCError({ code: 'CONFLICT', message: 'This origin is already active.' })
              const created = await tx.venueWebsiteOrigin.create({
                data: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  origin,
                  addedBy: ctx.session.userId,
                  addedReason: request.reason,
                },
                select: { id: true },
              })
              targetId = created.id
              afterState = { revision: bumped.revision, origin, state: 'ACTIVE' }
            } else if (change.kind === 'REVOKE_ORIGIN') {
              const origin = normalizeVenueWebsiteOrigin(change.origin)
              if (origin !== change.origin)
                throw new TRPCError({ code: 'BAD_REQUEST', message: 'Proposal origin is invalid.' })
              const active = await tx.venueWebsiteOrigin.findFirst({
                where: {
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  origin,
                  state: 'ACTIVE',
                },
                select: { id: true },
              })
              if (!active)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'This origin is no longer active.',
                })
              const changed = await tx.venueWebsiteOrigin.updateMany({
                where: {
                  id: active.id,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  state: 'ACTIVE',
                },
                data: {
                  state: 'REVOKED',
                  revokedAt: new Date(),
                  revokedBy: ctx.session.userId,
                  revokedReason: request.reason,
                },
              })
              if (changed.count !== 1)
                throw new TRPCError({ code: 'CONFLICT', message: 'Origin changed during review.' })
              targetId = active.id
              beforeState = { ...beforeState, origin, state: 'ACTIVE' }
              const bumped = await bumpDistribution(tx, {
                tenantId: input.tenantId,
                venueId: input.venueId,
                actorId: ctx.session.userId,
              })
              afterState = { revision: bumped.revision, origin, state: 'REVOKED' }
            } else {
              const field = change.surface === 'WEBSITE' ? 'websiteState' : 'appState'
              const state = change.enabled ? 'ENABLED' : 'DISABLED'
              beforeState = {
                ...beforeState,
                surface: change.surface,
                state: current?.[field] ?? 'DISABLED',
              }
              if (beforeState.state === state)
                throw new TRPCError({
                  code: 'CONFLICT',
                  message: 'Surface already has the proposed state.',
                })
              const bumped = await bumpDistribution(
                tx,
                { tenantId: input.tenantId, venueId: input.venueId, actorId: ctx.session.userId },
                { [field]: state },
              )
              afterState = { revision: bumped.revision, surface: change.surface, state }
            }
            const decision = await tx.approvalDecision.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                approvalRequestId: request.id,
                decision: 'APPROVED',
                decidedByType: 'HUMAN',
                decidedById: ctx.session.userId,
                reason: 'Applied exact distribution proposal in Visitor access.',
              },
              select: { id: true },
            })
            await tx.agentAction.create({
              data: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentRunId: request.agentRunId,
                agentIdentityId: request.agentIdentityId,
                approvalDecisionId: decision.id,
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                requestedOperation: 'distribution proposal review',
                actionName: distributionProposalAction,
                inputSummary: request.reason,
                inputReference: `ApprovalRequest:${request.id}`,
                output: { change, revision: afterState.revision },
                status: 'SUCCEEDED',
                beforeVersionRef: `VenueDistribution:${input.venueId}:${beforeState.revision}`,
                afterVersionRef: `VenueDistribution:${input.venueId}:${afterState.revision}`,
              },
            })
            await writeAuditLogStrict(
              {
                tenantId: input.tenantId,
                actorId: ctx.session.userId,
                actorRole: 'PLATFORM_ADMIN',
                action: 'admin.venue-distribution.proposal.applied',
                targetType:
                  change.kind === 'SET_SURFACE' ? 'VenueDistribution' : 'VenueWebsiteOrigin',
                targetId,
                beforeState: { ...beforeState, approvalRequestId: request.id },
                afterState: {
                  ...afterState,
                  approvalDecisionId: decision.id,
                  reason: request.reason,
                },
              },
              tx,
            )
            return {
              approvalDecisionId: decision.id,
              revision: afterState.revision as number,
              applied: true,
            }
          },
          { isolationLevel: 'Serializable' },
        )
        .catch((error: unknown) => {
          if (error instanceof TRPCError) throw error
          if (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            (error.code === 'P2034' || error.code === 'P2002')
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Distribution changed during review; refresh and try again.',
            })
          }
          throw error
        }),
    ),
})
