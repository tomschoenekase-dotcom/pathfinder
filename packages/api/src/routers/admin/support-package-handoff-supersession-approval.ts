import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION,
  SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY,
  SupportPackageHandoffSupersessionApplyParameters,
  SupportPackageHandoffSupersessionProposalSnapshot,
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

function translateError(error: unknown): never {
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

export const adminSupportHandoffSupersessionApprovalRouter = router({
  decideSupportPackageHandoffSupersessionProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not a support package handoff-supersession proposal',
              )
            }
            const snapshot = SupportPackageHandoffSupersessionProposalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support package handoff-supersession proposal scope is invalid',
              )
            }
            if (input.decision === 'APPROVED') {
              const current = await tx.supportRequest.findFirst({
                where: {
                  id: snapshot.data.requestId,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                },
                select: {
                  version: true,
                  status: true,
                  packageHandoffs: {
                    where: {
                      id: {
                        in: [
                          snapshot.data.superseded.handoffId,
                          snapshot.data.replacement.handoffId,
                        ],
                      },
                    },
                    select: {
                      id: true,
                      requestVersion: true,
                      supersessionAsPrior: { select: { id: true } },
                      venuePackage: {
                        select: {
                          id: true,
                          status: true,
                          updatedAt: true,
                          payloadHash: true,
                          appliedAt: true,
                          appliedBy: true,
                          appliedCommandKey: true,
                          revertedAt: true,
                          revertedBy: true,
                          revertedCommandKey: true,
                        },
                      },
                    },
                  },
                },
              })
              const prior = current?.packageHandoffs.find(
                (item) => item.id === snapshot.data.superseded.handoffId,
              )
              const replacement = current?.packageHandoffs.find(
                (item) => item.id === snapshot.data.replacement.handoffId,
              )
              if (
                !current ||
                current.version !== snapshot.data.expectedVersion ||
                current.status !== snapshot.data.supportRequestStatus ||
                !prior ||
                prior.supersessionAsPrior ||
                prior.requestVersion !== snapshot.data.superseded.handoffRequestVersion ||
                prior.venuePackage.id !== snapshot.data.superseded.packageId ||
                prior.venuePackage.status !== 'REVERTED' ||
                prior.venuePackage.updatedAt.toISOString() !==
                  snapshot.data.superseded.packageUpdatedAt ||
                prior.venuePackage.payloadHash !== snapshot.data.superseded.payloadHash ||
                prior.venuePackage.revertedAt?.toISOString() !==
                  snapshot.data.superseded.revertedAt ||
                prior.venuePackage.revertedBy !== snapshot.data.superseded.revertedBy ||
                prior.venuePackage.revertedCommandKey !==
                  snapshot.data.superseded.revertedCommandKey ||
                !replacement ||
                replacement.requestVersion !== snapshot.data.replacement.handoffRequestVersion ||
                replacement.venuePackage.id !== snapshot.data.replacement.packageId ||
                replacement.venuePackage.status !== 'APPLIED' ||
                replacement.venuePackage.updatedAt.toISOString() !==
                  snapshot.data.replacement.packageUpdatedAt ||
                replacement.venuePackage.payloadHash !== snapshot.data.replacement.payloadHash ||
                replacement.venuePackage.appliedAt?.toISOString() !==
                  snapshot.data.replacement.appliedAt ||
                replacement.venuePackage.appliedBy !== snapshot.data.replacement.appliedBy ||
                replacement.venuePackage.appliedCommandKey !==
                  snapshot.data.replacement.appliedCommandKey
              ) {
                throw new ApprovalDecisionActionError(
                  'CONFLICT',
                  'Support request or exact handoff lineage changed; refresh before deciding',
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
            const parameters = SupportPackageHandoffSupersessionApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              requestId: snapshot.data.requestId,
              expectedVersion: snapshot.data.expectedVersion,
              supportRequestStatus: snapshot.data.supportRequestStatus,
              superseded: snapshot.data.superseded,
              replacement: snapshot.data.replacement,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_APPLY_ACTION,
                capability: SUPPORT_PACKAGE_HANDOFF_SUPERSESSION_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_SUPPORT_PACKAGE_HANDOFF_CURRENT_TRUTH_SUPERSESSION',
                  historicalHandoffPreserved: true,
                  replacementAlreadyApplied: true,
                  packageLifecycleChangeIncluded: false,
                  supportStatusChangeIncluded: false,
                  clientActivityChangeIncluded: false,
                  customerContactIncluded: false,
                  externalEffectIncluded: false,
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support package handoff supersession ${request.id}.`,
                ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
                actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
              },
              sameTransaction,
            )
            return { decision, approvalGrant, executionTriggered: false as const }
          })
        } catch (error) {
          translateError(error)
        }
      }),
    ),
})
