import { buildVenueAccessArtifacts } from '@pathfinder/contracts'
import {
  db,
  getVenueDistributionSessionCounts,
  normalizeVenueWebsiteOrigin,
  resolveVenueDistribution,
} from '@pathfinder/db'
import type { PathfinderMcpDomainActions } from './registry'

const PROPOSED_ACTION = 'torchiko.distribution.apply_change'

function fail(message: string): never {
  throw new Error(message)
}

/** MCP can read scoped state and retain a proposal. Only admin procedures can apply it. */
export function createDistributionMcpActions(
  database: typeof db,
): Pick<PathfinderMcpDomainActions, 'distributionGet' | 'distributionProposeChange'> {
  return {
    async distributionGet(input, context) {
      const venue = await database.venue.findFirst({
        where: { id: input.venueId, tenantId: context.credential.tenantId },
        select: { id: true, tenantId: true, slug: true, isActive: true },
      })
      if (!venue) return fail('Venue is unavailable in this tenant')
      const [state, origins, counts] = await Promise.all([
        resolveVenueDistribution({
          client: database,
          venueSlug: venue.slug,
          venueTarget: { venueId: venue.id, tenantId: venue.tenantId },
        }),
        database.venueWebsiteOrigin.findMany({
          where: { tenantId: venue.tenantId, venueId: venue.id },
          orderBy: [{ addedAt: 'desc' }, { id: 'desc' }],
          take: 100,
          select: {
            id: true,
            origin: true,
            state: true,
            addedAt: true,
            addedReason: true,
            revokedAt: true,
            revokedReason: true,
          },
        }),
        getVenueDistributionSessionCounts(database, venue.tenantId, venue.id),
      ])
      const artifacts = buildVenueAccessArtifacts(process.env.NEXT_PUBLIC_WEB_URL, venue.slug)
      return {
        kind: 'torchiko.distribution-readback',
        summary: 'Scoped venue distribution readback. Availability is enforced by the resolver.',
        data: JSON.parse(JSON.stringify({ venueId: venue.id, state, artifacts, origins, counts })),
      }
    },
    async distributionProposeChange(input, context) {
      const now = new Date()
      const [venue, worker, identity] = await Promise.all([
        database.venue.findFirst({
          where: { id: input.venueId, tenantId: context.credential.tenantId },
          select: { id: true, tenantId: true, slug: true, isActive: true },
        }),
        database.agentWorker.findFirst({
          where: {
            workerKey: input.workerKey,
            tenantId: context.credential.tenantId,
            clientId: context.credential.clientId,
            credentialId: context.credential.credentialId,
            status: 'ONLINE',
            leaseExpiresAt: { gt: now },
            capabilities: { has: 'distribution:propose' },
          },
          select: { id: true, modelProvider: true, modelName: true },
        }),
        database.agentIdentity.findFirst({
          where: { id: input.agentIdentityId, tenantId: context.credential.tenantId },
          select: { id: true },
        }),
      ])
      if (!venue || !worker || !identity)
        return fail('Verified distribution proposal scope is unavailable')
      const run = await database.agentRun.findFirst({
        where: {
          id: input.agentRunId,
          tenantId: venue.tenantId,
          venueId: venue.id,
          agentIdentityId: identity.id,
          executionWorkerId: worker.id,
          status: { in: ['RUNNING', 'AWAITING_APPROVAL'] },
          executionLeaseExpiresAt: { gt: now },
        },
        select: { id: true, requestedOperation: true },
      })
      if (!run) return fail('Verified distribution worker run is unavailable')
      const change =
        input.change.kind === 'SET_SURFACE'
          ? input.change
          : {
              ...input.change,
              origin:
                normalizeVenueWebsiteOrigin(input.change.origin) ??
                fail('A canonical HTTPS origin is required'),
            }
      const current = await resolveVenueDistribution({
        client: database,
        venueSlug: venue.slug,
        venueTarget: { venueId: venue.id, tenantId: venue.tenantId },
      })
      if (!current) return fail('Venue distribution is unavailable')
      const snapshot = {
        venueId: venue.id,
        tenantId: venue.tenantId,
        expectedRevision: current.revision,
        change,
      }
      const existing = await database.approvalRequest.findFirst({
        where: { id: input.operationId, tenantId: venue.tenantId },
        select: {
          id: true,
          agentRunId: true,
          agentIdentityId: true,
          proposedAction: true,
          scopeSnapshot: true,
          reason: true,
        },
      })
      if (existing) {
        if (
          existing.agentRunId !== run.id ||
          existing.agentIdentityId !== identity.id ||
          existing.proposedAction !== PROPOSED_ACTION ||
          JSON.stringify(existing.scopeSnapshot) !== JSON.stringify(snapshot) ||
          existing.reason !== input.reason
        )
          return fail('Operation ID is already used for a different proposal')
        return {
          kind: 'torchiko.distribution-change-proposal',
          summary: 'Existing pending proposal returned; distribution remains unchanged.',
          data: { approvalRequestId: existing.id, replayed: true, applied: false },
        }
      }
      const proposal = await database.$transaction(async (tx) => {
        const approval = await tx.approvalRequest.create({
          data: {
            id: input.operationId,
            tenantId: venue.tenantId,
            venueId: venue.id,
            agentIdentityId: identity.id,
            agentRunId: run.id,
            requestedByType: 'AGENT',
            requestedById: identity.id,
            proposedAction: PROPOSED_ACTION,
            scopeSnapshot: snapshot,
            reason: input.reason,
            riskCategory: 'HIGH',
            artifacts: [],
          },
          select: { id: true },
        })
        const action = await tx.agentAction.create({
          data: {
            tenantId: venue.tenantId,
            venueId: venue.id,
            agentRunId: run.id,
            agentIdentityId: identity.id,
            actorType: 'AGENT',
            actorId: identity.id,
            requestedOperation: run.requestedOperation,
            actionName: 'torchiko.distribution.propose_change',
            inputSummary: input.reason,
            inputReference: `VenueDistribution:${venue.id}:${current.revision}`,
            output: { approvalRequestId: approval.id, change },
            modelProvider: worker.modelProvider,
            modelName: worker.modelName,
            status: 'SUCCEEDED',
            beforeVersionRef: `VenueDistribution:${venue.id}:${current.revision}`,
            afterVersionRef: `ApprovalRequest:${approval.id}:PENDING`,
          },
          select: { id: true },
        })
        await tx.agentTimelineEvent.create({
          data: {
            tenantId: venue.tenantId,
            venueId: venue.id,
            agentRunId: run.id,
            agentActionId: action.id,
            actorType: 'AGENT',
            actorId: identity.id,
            eventType: 'DISTRIBUTION_PROPOSED',
            message: 'Distribution change proposed for platform-admin review.',
            data: { approvalRequestId: approval.id },
          },
        })
        await tx.agentRun.updateMany({
          where: { id: run.id, tenantId: venue.tenantId, venueId: venue.id, status: 'RUNNING' },
          data: { status: 'AWAITING_APPROVAL' },
        })
        return approval
      })
      return {
        kind: 'torchiko.distribution-change-proposal',
        summary: 'Pending proposal recorded; only a platform admin can apply it.',
        data: { approvalRequestId: proposal.id, replayed: false, applied: false },
      }
    },
  }
}
