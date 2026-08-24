import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  approvalState,
  createdBefore,
  pageInput,
  pageResult,
  tenantScopeInput,
} from './agent-operations-shared'
import { adminAgentIdentityReadsRouter } from './agent-identity-reads'
import { adminAgentRunTraceRouter } from './agent-run-trace'
import { customerAccessApprovalSelect } from './customer-access-approval-select'

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

  listApprovalRequests: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        state: z.enum(['PENDING', 'RESOLVED', 'EXPIRED', 'ALL']).default('PENDING'),
        riskCategory: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
        agentIdentityId: z.string().min(1).optional(),
        agentRunId: z.string().min(1).optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const stateWhere =
          input.state === 'PENDING'
            ? { decision: { is: null }, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
            : input.state === 'EXPIRED'
              ? { decision: { is: null }, expiresAt: { lte: now } }
              : input.state === 'RESOLVED'
                ? { decision: { isNot: null } }
                : {}
        const rows = await db.approvalRequest.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.riskCategory ? { riskCategory: input.riskCategory } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            ...stateWhere,
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentIdentityId: true,
            agentRunId: true,
            requestedByType: true,
            requestedById: true,
            proposedAction: true,
            reason: true,
            riskCategory: true,
            expiresAt: true,
            createdAt: true,
            agentIdentity: { select: { id: true, name: true } },
            venue: { select: { id: true, name: true } },
            customerAccessRequest: {
              select: customerAccessApprovalSelect,
            },
            decision: {
              select: {
                id: true,
                decision: true,
                decidedByType: true,
                decidedById: true,
                reason: true,
                createdAt: true,
              },
            },
          },
        })
        const page = pageResult(rows, input.limit)
        return {
          ...page,
          items: page.items.map((request) => ({
            ...request,
            state: approvalState(request, now),
          })),
        }
      }),
    ),

  getApprovalRequest: adminProcedure
    .input(tenantScopeInput.extend({ approvalRequestId: z.string().min(1) }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const request = await db.approvalRequest.findFirst({
          where: {
            id: input.approvalRequestId,
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            agentIdentityId: true,
            agentRunId: true,
            requestedByType: true,
            requestedById: true,
            proposedAction: true,
            reason: true,
            riskCategory: true,
            expiresAt: true,
            createdAt: true,
            agentIdentity: { select: { id: true, name: true } },
            venue: { select: { id: true, name: true } },
            customerAccessRequest: {
              select: customerAccessApprovalSelect,
            },
            decision: {
              select: {
                id: true,
                decision: true,
                decidedByType: true,
                decidedById: true,
                reason: true,
                createdAt: true,
              },
            },
          },
        })
        if (!request) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval request not found' })
        }
        return { ...request, state: approvalState(request, now) }
      }),
    ),
})

export const adminAgentOperationsRouter = mergeRouters(
  adminAgentRunOperationsRouter,
  adminAgentIdentityReadsRouter,
  adminAgentRunTraceRouter,
)
