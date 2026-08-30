import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_REVERSION_APPLY_ACTION,
  SUPPORT_PACKAGE_REVERSION_CAPABILITY,
  SupportPackageReversionApplyParameters,
  SupportPackageReversionProposalSnapshot,
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
import { supportPackageRollbackManifestDigest } from '../../lib/support-package-reversion-actions'

function approvalGrantError(error: unknown): never {
  if (error instanceof ApprovalDecisionActionError || error instanceof ApprovalGrantActionError) {
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

export const adminSupportReversionApprovalRouter = router({
  decideSupportPackageReversionProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_PACKAGE_REVERSION_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support package-reversion proposal',
              )
            }
            const snapshot = SupportPackageReversionProposalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support package-reversion proposal scope is invalid',
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
                  appliedEntities: true,
                  appliedAt: true,
                  appliedBy: true,
                  appliedCommandKey: true,
                  supportHandoffs: {
                    where: { id: snapshot.data.supportHandoff.handoffId },
                    take: 1,
                    select: {
                      supportRequestId: true,
                      requestVersion: true,
                      supportRequest: { select: { version: true, status: true } },
                    },
                  },
                },
              })
              const handoff = pkg?.supportHandoffs[0]
              if (
                !pkg ||
                pkg.status !== 'APPLIED' ||
                pkg.updatedAt.toISOString() !== snapshot.data.expectedUpdatedAt ||
                pkg.payloadHash !== snapshot.data.payloadHash ||
                pkg.baseDigest !== snapshot.data.baseDigest ||
                supportPackageRollbackManifestDigest(pkg.appliedEntities) !==
                  snapshot.data.rollbackManifestDigest ||
                pkg.appliedAt?.toISOString() !== snapshot.data.appliedAt ||
                pkg.appliedBy !== snapshot.data.appliedBy ||
                pkg.appliedCommandKey !== snapshot.data.appliedCommandKey ||
                !handoff ||
                handoff.supportRequestId !== snapshot.data.supportHandoff.supportRequestId ||
                handoff.requestVersion !== snapshot.data.supportHandoff.supportRequestVersion ||
                handoff.supportRequest.version !== snapshot.data.supportRequestVersion ||
                handoff.supportRequest.status !== snapshot.data.supportRequestStatus
              ) {
                throw new ApprovalDecisionActionError(
                  'CONFLICT',
                  'Support-linked applied package or active request changed; refresh before deciding reversion',
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
            const parameters = SupportPackageReversionApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              packageId: snapshot.data.packageId,
              expectedUpdatedAt: snapshot.data.expectedUpdatedAt,
              payloadHash: snapshot.data.payloadHash,
              baseDigest: snapshot.data.baseDigest,
              rollbackManifestDigest: snapshot.data.rollbackManifestDigest,
              appliedAt: snapshot.data.appliedAt,
              appliedBy: snapshot.data.appliedBy,
              appliedCommandKey: snapshot.data.appliedCommandKey,
              supportHandoff: snapshot.data.supportHandoff,
              supportRequestVersion: snapshot.data.supportRequestVersion,
              supportRequestStatus: snapshot.data.supportRequestStatus,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_PACKAGE_REVERSION_APPLY_ACTION,
                capability: SUPPORT_PACKAGE_REVERSION_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_APPLIED_SUPPORT_PACKAGE_CANONICAL_REVERSION',
                  canonicalDriftCheckRequired: true,
                  automaticRollbackPolicyIncluded: false,
                  supportRequestChangeIncluded: false,
                  customerContactIncluded: false,
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support package-reversion proposal ${request.id}.`,
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
