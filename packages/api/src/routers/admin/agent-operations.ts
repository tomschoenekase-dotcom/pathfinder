import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  approvalState,
  createdBefore,
  pageInput,
  pageResult,
  tenantScopeInput,
} from './agent-operations-shared'

/**
 * Read-only operator surfaces for the agent control plane. Raw JSON inputs,
 * outputs, scope snapshots, timeline data, and artifacts are deliberately not
 * returned here; future reveal endpoints need their own authorization review.
 */
export const adminAgentOperationsRouter = router({
  listAgentIdentities: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        enabled: z.boolean().optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentIdentity.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            identityKey: true,
            name: true,
            description: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            enabled: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            venue: { select: { id: true, name: true } },
            _count: { select: { runs: true, approvalRequests: true } },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  getAgentIdentity: adminProcedure
    .input(tenantScopeInput.extend({ agentIdentityId: z.string().min(1) }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const identity = await db.agentIdentity.findFirst({
          where: {
            id: input.agentIdentityId,
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            identityKey: true,
            name: true,
            description: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            enabled: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            venue: { select: { id: true, name: true } },
            _count: { select: { runs: true, actions: true, approvalRequests: true } },
          },
        })
        if (!identity) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent identity not found' })
        }
        return identity
      }),
    ),

  listAgentRuns: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentIdentityId: z.string().min(1).optional(),
        status: z
          .enum(['QUEUED', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'])
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
            runType: true,
            requestedOperation: true,
            status: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            errorCode: true,
            initiatedByType: true,
            initiatedById: true,
            cancelRequestedAt: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true, enabled: true } },
            venue: { select: { id: true, name: true } },
            _count: { select: { actions: true, timelineEvents: true, approvalRequests: true } },
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
            runType: true,
            requestedOperation: true,
            status: true,
            modelProvider: true,
            modelName: true,
            costE8Usd: true,
            errorCode: true,
            errorMessage: true,
            initiatedByType: true,
            initiatedById: true,
            cancelRequestedAt: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true, enabled: true } },
            venue: { select: { id: true, name: true } },
            _count: { select: { actions: true, timelineEvents: true, approvalRequests: true } },
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
