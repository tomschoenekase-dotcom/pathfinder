import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SUPPORT_COMPLETION_APPLY_ACTION,
  SUPPORT_COMPLETION_CAPABILITY,
  SupportCompletionApplyParameters,
  SupportCompletionProposalApprovalSnapshot,
} from '@pathfinder/contracts'
import {
  ApprovalDecisionActionError,
  ApprovalGrantActionError,
  db,
  issueApprovalGrantAction,
  recordApprovalDecisionAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function approvalGrantError(error: unknown): never {
  if (error instanceof ApprovalDecisionActionError) {
    const code =
      error.code === 'FORBIDDEN'
        ? 'FORBIDDEN'
        : error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : 'CONFLICT'
    throw new TRPCError({ code, message: error.message })
  }
  if (error instanceof ApprovalGrantActionError) {
    const code =
      error.code === 'INVALID_INPUT'
        ? 'BAD_REQUEST'
        : error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT'
    throw new TRPCError({ code, message: error.message })
  }
  throw error
}

export const adminSupportCompletionApprovalRouter = router({
  decideSupportCompletionProposal: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          approvalRequestId: z.string().min(1),
          decision: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
          reason: z.string().trim().min(1).max(2000).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await db.$transaction(async (tx) => {
            const request = await tx.approvalRequest.findFirst({
              where: {
                id: input.approvalRequestId,
                tenantId: input.tenantId,
                venueId: input.venueId,
              },
              select: {
                id: true,
                agentIdentityId: true,
                proposedAction: true,
                scopeSnapshot: true,
                expiresAt: true,
              },
            })
            if (!request) {
              throw new ApprovalDecisionActionError('NOT_FOUND', 'Approval request not found')
            }
            if (request.proposedAction !== SUPPORT_COMPLETION_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support-completion proposal',
              )
            }
            const snapshot = SupportCompletionProposalApprovalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support-completion proposal scope is invalid or no longer matches the request',
              )
            }
            const sameTransaction = {
              $transaction: async (callback: (inner: typeof tx) => unknown) => callback(tx),
            } as never
            const decision = await recordApprovalDecisionAction(
              {
                tenantId: input.tenantId,
                venueId: input.venueId,
                approvalRequestId: request.id,
                decision: input.decision,
                ...(input.reason ? { reason: input.reason } : {}),
                actor: {
                  actorType: 'HUMAN',
                  actorId: ctx.session.userId,
                  auditRole: 'PLATFORM_ADMIN',
                },
              },
              sameTransaction,
            )
            if (input.decision !== 'APPROVED') {
              return { decision, approvalGrant: null, executionTriggered: false as const }
            }
            const parameters = SupportCompletionApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              requestId: snapshot.data.requestId,
              expectedVersion: snapshot.data.expectedVersion,
              fromStatus: snapshot.data.fromStatus,
              toStatus: snapshot.data.toStatus,
              body: snapshot.data.body,
              packageFulfillment: snapshot.data.packageFulfillment,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_COMPLETION_APPLY_ACTION,
                capability: SUPPORT_COMPLETION_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 2,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_FULFILLMENT_BOUND_CLIENT_COMPLETION_ONLY',
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support completion proposal ${request.id}.`,
                ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
                actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
              },
              sameTransaction,
            )
            return { decision, approvalGrant, executionTriggered: false as const }
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),
})
