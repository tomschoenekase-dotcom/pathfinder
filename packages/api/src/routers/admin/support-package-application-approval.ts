import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION,
  SUPPORT_PACKAGE_APPLICATION_CAPABILITY,
  SupportPackageApplicationApplyParameters,
  SupportPackageApplicationProposalSnapshot,
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
    throw new TRPCError({
      code:
        error.code === 'FORBIDDEN'
          ? 'FORBIDDEN'
          : error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : 'CONFLICT',
      message: error.message,
    })
  }
  if (error instanceof ApprovalGrantActionError) {
    throw new TRPCError({
      code:
        error.code === 'INVALID_INPUT'
          ? 'BAD_REQUEST'
          : error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : error.code === 'NOT_FOUND'
              ? 'NOT_FOUND'
              : 'CONFLICT',
      message: error.message,
    })
  }
  throw error
}

export const adminSupportApplicationApprovalRouter = router({
  decideSupportPackageApplicationProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support package-application proposal',
              )
            }
            const snapshot = SupportPackageApplicationProposalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support package-application proposal scope is invalid',
              )
            }
            if (input.decision === 'APPROVED') {
              const pkg = await tx.venuePackage.findFirst({
                where: {
                  id: snapshot.data.packageId,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                },
                select: {
                  status: true,
                  updatedAt: true,
                  payloadHash: true,
                  baseDigest: true,
                  approvedAt: true,
                  approvedBy: true,
                  previewPlan: true,
                  supportHandoffs: {
                    where: { id: snapshot.data.supportHandoff.handoffId },
                    take: 1,
                    select: { supportRequestId: true, requestVersion: true },
                  },
                },
              })
              const preview = z
                .object({ warningDigest: z.string().regex(/^[a-f0-9]{64}$/) })
                .passthrough()
                .safeParse(pkg?.previewPlan)
              const handoff = pkg?.supportHandoffs[0]
              if (
                !pkg ||
                pkg.status !== 'APPROVED' ||
                pkg.updatedAt.toISOString() !== snapshot.data.expectedUpdatedAt ||
                pkg.payloadHash !== snapshot.data.payloadHash ||
                pkg.baseDigest !== snapshot.data.baseDigest ||
                pkg.approvedAt?.toISOString() !== snapshot.data.approvedAt ||
                pkg.approvedBy !== snapshot.data.approvedBy ||
                !preview.success ||
                preview.data.warningDigest !== snapshot.data.warningDigest ||
                !handoff ||
                handoff.supportRequestId !== snapshot.data.supportHandoff.supportRequestId ||
                handoff.requestVersion !== snapshot.data.supportHandoff.supportRequestVersion
              ) {
                throw new ApprovalDecisionActionError(
                  'CONFLICT',
                  'Support-linked approved package changed; refresh before deciding application',
                )
              }
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
            const parameters = SupportPackageApplicationApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              packageId: snapshot.data.packageId,
              expectedUpdatedAt: snapshot.data.expectedUpdatedAt,
              payloadHash: snapshot.data.payloadHash,
              baseDigest: snapshot.data.baseDigest,
              warningDigest: snapshot.data.warningDigest,
              approvedAt: snapshot.data.approvedAt,
              approvedBy: snapshot.data.approvedBy,
              supportHandoff: snapshot.data.supportHandoff,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_PACKAGE_APPLICATION_APPLY_ACTION,
                capability: SUPPORT_PACKAGE_APPLICATION_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_APPROVED_SUPPORT_PACKAGE_TO_CURRENT_CONTENT',
                  currentContentMutation: true,
                  visitorVisibleChangePossible: true,
                  supportCompletionIncluded: false,
                  customerContactIncluded: false,
                  revertIncluded: false,
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support package-application proposal ${request.id}.`,
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
