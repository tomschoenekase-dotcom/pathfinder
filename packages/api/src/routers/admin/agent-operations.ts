import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'
import { adminAgentIdentityReadsRouter } from './agent-identity-reads'
import { adminAgentApprovalPolicyReadsRouter } from './agent-approval-policy-reads'
import { adminAgentRunTraceRouter } from './agent-run-trace'
import { adminAgentApprovalRequestReadsRouter } from './agent-approval-request-reads'

/**
 * Read-only operator surfaces for the agent control plane. Raw JSON inputs,
 * scope snapshots, raw action payloads, and lease tokens are deliberately not
 * returned. Platform admins can read bounded prompts and result artifacts so
 * this workspace is useful without exposing execution authority.
 */
const adminAgentRunOperationsRouter = router({
  listAgentRuns: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentIdentityId: z.string().min(1).optional(),
        status: z
          .enum([
            'QUEUED',
            'RUNNING',
            'AWAITING_INPUT',
            'AWAITING_APPROVAL',
            'COMPLETED',
            'FAILED',
            'CANCELLED',
          ])
          .optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentRun.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentIdentityId: true,
            parentAgentRunId: true,
            delegationReason: true,
            runType: true,
            requestedOperation: true,
            requestPrompt: true,
            status: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            costStatus: true,
            errorCode: true,
            initiatedByType: true,
            initiatedById: true,
            cancelRequestedAt: true,
            attemptNumber: true,
            maxAttempts: true,
            lastHeartbeatAt: true,
            executionLeaseExpiresAt: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true, enabled: true } },
            parentAgentRun: {
              select: { id: true, agentIdentity: { select: { id: true, name: true } } },
            },
            venue: { select: { id: true, name: true } },
            _count: {
              select: {
                actions: true,
                timelineEvents: true,
                approvalRequests: true,
                delegatedRuns: true,
                outcomeObservations: true,
              },
            },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  getAgentRun: adminProcedure
    .input(tenantScopeInput.extend({ agentRunId: z.string().min(1) }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const run = await db.agentRun.findFirst({
          where: {
            id: input.agentRunId,
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentIdentityId: true,
            parentAgentRunId: true,
            delegationReason: true,
            runType: true,
            requestedOperation: true,
            requestPrompt: true,
            artifacts: true,
            status: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            costStatus: true,
            errorCode: true,
            errorMessage: true,
            initiatedByType: true,
            initiatedById: true,
            cancelRequestedAt: true,
            attemptNumber: true,
            maxAttempts: true,
            lastHeartbeatAt: true,
            executionLeaseExpiresAt: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true, enabled: true } },
            parentAgentRun: {
              select: { id: true, agentIdentity: { select: { id: true, name: true } } },
            },
            delegatedRuns: {
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: 25,
              select: {
                id: true,
                status: true,
                delegationReason: true,
                createdAt: true,
                agentIdentity: { select: { id: true, name: true } },
              },
            },
            messages: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: 100,
              select: {
                id: true,
                role: true,
                messageType: true,
                content: true,
                actorId: true,
                createdAt: true,
              },
            },
            venue: { select: { id: true, name: true } },
            _count: {
              select: {
                actions: true,
                timelineEvents: true,
                approvalRequests: true,
                delegatedRuns: true,
                outcomeObservations: true,
              },
            },
          },
        })
        if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent run not found' })
        return run
      }),
    ),

  listAgentRunActions: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentRunId: z.string().min(1),
        status: z.enum(['SUCCEEDED', 'FAILED', 'DENIED', 'CANCELLED']).optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentAction.findMany({
          where: {
            tenantId: input.tenantId,
            agentRunId: input.agentRunId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.status ? { status: input.status } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentRunId: true,
            agentIdentityId: true,
            approvalDecisionId: true,
            actorType: true,
            actorId: true,
            requestedOperation: true,
            actionName: true,
            inputSummary: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            status: true,
            errorCode: true,
            errorMessage: true,
            beforeVersionRef: true,
            afterVersionRef: true,
            createdAt: true,
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  listAgentRunTimeline: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentRunId: z.string().min(1),
        agentActionId: z.string().min(1).optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentTimelineEvent.findMany({
          where: {
            tenantId: input.tenantId,
            agentRunId: input.agentRunId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentActionId ? { agentActionId: input.agentActionId } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentRunId: true,
            agentActionId: true,
            actorType: true,
            actorId: true,
            eventType: true,
            message: true,
            createdAt: true,
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),
})

export const adminAgentOperationsRouter = mergeRouters(
  adminAgentRunOperationsRouter,
  adminAgentApprovalRequestReadsRouter,
  adminAgentApprovalPolicyReadsRouter,
  adminAgentIdentityReadsRouter,
  adminAgentRunTraceRouter,
)
