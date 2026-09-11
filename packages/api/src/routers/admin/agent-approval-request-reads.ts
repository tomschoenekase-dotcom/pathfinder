import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import {
  SUPPORT_COMPLETION_APPLY_ACTION,
  SupportCompletionProposalApprovalSnapshot,
} from '@pathfinder/contracts'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import {
  approvalState,
  createdBefore,
  pageInput,
  pageResult,
  tenantScopeInput,
} from './agent-operations-shared'
import { customerAccessApprovalSelect } from './customer-access-approval-select'

function supportCompletionProposalProjection(input: {
  proposedAction: string
  scopeSnapshot: unknown
}): {
  completionOutcome: 'UPDATED' | 'NO_CHANGE' | 'MIXED' | 'RESOLVED' | null
  body: string
  reviewedDeclines?: Array<{ proposalSummary: string; reviewNote: string }>
} | null {
  if (input.proposedAction !== SUPPORT_COMPLETION_APPLY_ACTION) return null
  const snapshot = SupportCompletionProposalApprovalSnapshot.safeParse(input.scopeSnapshot)
  if (!snapshot.success) return null
  return {
    completionOutcome: snapshot.data.completionOutcome ?? null,
    body: snapshot.data.body,
    ...(snapshot.data.packageFulfillment.contractVersion === 7
      ? {
          reviewedDeclines:
            snapshot.data.packageFulfillment.proposalResolutionFulfillment.declines.map(
              ({ proposalSummary, reviewNote }) => ({ proposalSummary, reviewNote }),
            ),
        }
      : {}),
  }
}

export const adminAgentApprovalRequestReadsRouter = router({
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
            scopeSnapshot: true,
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
          items: page.items.map(({ scopeSnapshot, ...request }) => ({
            ...request,
            supportCompletionProposal: supportCompletionProposalProjection({
              proposedAction: request.proposedAction,
              scopeSnapshot,
            }),
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
            scopeSnapshot: true,
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
        const { scopeSnapshot, ...safeRequest } = request
        return {
          ...safeRequest,
          supportCompletionProposal: supportCompletionProposalProjection({
            proposedAction: safeRequest.proposedAction,
            scopeSnapshot,
          }),
          state: approvalState(safeRequest, now),
        }
      }),
    ),
})
