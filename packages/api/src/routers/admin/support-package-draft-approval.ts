import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION,
  SUPPORT_PACKAGE_APPROVAL_CAPABILITY,
  SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
  SUPPORT_PACKAGE_DRAFT_CAPABILITY,
  SupportPackageApprovalApplyParameters,
  SupportPackageApprovalProposalSnapshot,
  SupportPackageDraftApplyParameters,
  SupportPackageDraftProposalApprovalSnapshot,
} from '@pathfinder/contracts'
import {
  ApprovalDecisionActionError,
  ApprovalGrantActionError,
  db,
  issueApprovalGrantAction,
  recordApprovalDecisionAction,
  supportPackageDraftPayloadHash,
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

export const adminSupportDraftApprovalRouter = router({
  decideSupportPackageApprovalProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support package-approval proposal',
              )
            }
            const snapshot = SupportPackageApprovalProposalSnapshot.safeParse(request.scopeSnapshot)
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support package-approval proposal scope is invalid',
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
                  id: true,
                  status: true,
                  updatedAt: true,
                  payloadHash: true,
                  baseDigest: true,
                  previewPlan: true,
                  supportHandoffs: {
                    where: { id: snapshot.data.supportHandoff.handoffId },
                    take: 1,
                    select: {
                      id: true,
                      supportRequestId: true,
                      requestVersion: true,
                    },
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
                pkg.status !== 'DRAFT' ||
                pkg.updatedAt.toISOString() !== snapshot.data.expectedUpdatedAt ||
                pkg.payloadHash !== snapshot.data.payloadHash ||
                pkg.baseDigest !== snapshot.data.baseDigest ||
                !preview.success ||
                preview.data.warningDigest !== snapshot.data.warningDigest ||
                !handoff ||
                handoff.supportRequestId !== snapshot.data.supportHandoff.supportRequestId ||
                handoff.requestVersion !== snapshot.data.supportHandoff.supportRequestVersion
              ) {
                throw new ApprovalDecisionActionError(
                  'CONFLICT',
                  'Support-linked package changed; refresh before deciding approval',
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
            const parameters = SupportPackageApprovalApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              packageId: snapshot.data.packageId,
              expectedUpdatedAt: snapshot.data.expectedUpdatedAt,
              payloadHash: snapshot.data.payloadHash,
              baseDigest: snapshot.data.baseDigest,
              warningDigest: snapshot.data.warningDigest,
              supportHandoff: snapshot.data.supportHandoff,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_PACKAGE_APPROVAL_APPLY_ACTION,
                capability: SUPPORT_PACKAGE_APPROVAL_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_SUPPORT_LINKED_PACKAGE_DRAFT_TO_APPROVED_ONLY',
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support package-approval proposal ${request.id}.`,
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

  decideSupportPackageDraftProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_PACKAGE_DRAFT_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support package-draft proposal',
              )
            }
            const snapshot = SupportPackageDraftProposalApprovalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId ||
              supportPackageDraftPayloadHash(snapshot.data.payload) !==
                snapshot.data.proposalPayloadHash
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support package-draft proposal scope is invalid or no longer matches the request',
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
            const parameters = SupportPackageDraftApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              requestId: snapshot.data.requestId,
              expectedVersion: snapshot.data.expectedVersion,
              fromStatus: snapshot.data.fromStatus,
              draftKey: snapshot.data.draftKey,
              payload: snapshot.data.payload,
              proposalPayloadHash: snapshot.data.proposalPayloadHash,
              operationCounts: snapshot.data.operationCounts,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_PACKAGE_DRAFT_APPLY_ACTION,
                capability: SUPPORT_PACKAGE_DRAFT_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_SUPPORT_LINKED_V3_DRAFT_ONLY',
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support package-draft proposal ${request.id}.`,
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
