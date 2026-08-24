import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  defaultSupportRequestOpenPolicyConstraints,
  SUPPORT_REQUEST_OPEN_POLICY_ACTION,
  SUPPORT_REQUEST_OPEN_POLICY_CAPABILITY,
  defaultSupportInternalNotePolicyConstraints,
  SUPPORT_INTERNAL_NOTE_POLICY_ACTION,
  SUPPORT_INTERNAL_NOTE_POLICY_CAPABILITY,
  SUPPORT_INFORMATION_REQUEST_APPLY_ACTION,
  SUPPORT_INFORMATION_REQUEST_CAPABILITY,
  SupportInformationRequestApplyParameters,
  SupportInformationRequestProposalApprovalSnapshot,
  SUPPORT_TRIAGE_APPLY_ACTION,
  SUPPORT_TRIAGE_APPLY_CAPABILITY,
  SupportTriageApplyParameters,
  SupportTriageProposalApprovalSnapshot,
} from '@pathfinder/contracts'
import {
  ApprovalGrantActionError,
  ApprovalDecisionActionError,
  db,
  issueApprovalGrantAction,
  recordApprovalDecisionAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { agentApprovalPolicyKey } from './agent-approval-policy-schemas'

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

export const adminSupportOpenPolicyRouter = router({
  decideSupportInformationRequestProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_INFORMATION_REQUEST_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support-information proposal',
              )
            }
            const snapshot = SupportInformationRequestProposalApprovalSnapshot.safeParse(
              request.scopeSnapshot,
            )
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support-information proposal scope is invalid or no longer matches the request',
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
            const parameters = SupportInformationRequestApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              requestId: snapshot.data.requestId,
              expectedVersion: snapshot.data.expectedVersion,
              fromStatus: snapshot.data.fromStatus,
              toStatus: snapshot.data.toStatus,
              body: snapshot.data.body,
              missingInformation: snapshot.data.missingInformation,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_INFORMATION_REQUEST_APPLY_ACTION,
                capability: SUPPORT_INFORMATION_REQUEST_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_CLIENT_INFORMATION_REQUEST_ONLY',
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support information request proposal ${request.id}.`,
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
  decideSupportTriageProposal: adminProcedure
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
            if (request.proposedAction !== SUPPORT_TRIAGE_APPLY_ACTION) {
              throw new ApprovalDecisionActionError(
                'FORBIDDEN',
                'Approval request is not an executable support-triage proposal',
              )
            }
            const snapshot = SupportTriageProposalApprovalSnapshot.safeParse(request.scopeSnapshot)
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            ) {
              throw new ApprovalDecisionActionError(
                'CONFLICT',
                'Support-triage proposal scope is invalid or no longer matches the request',
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
            const parameters = SupportTriageApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              requestId: snapshot.data.requestId,
              expectedVersion: snapshot.data.expectedVersion,
              category: snapshot.data.proposedCategory,
              missingInformation: snapshot.data.proposedMissingInformation,
            })
            const approvalGrant = await issueApprovalGrantAction(
              {
                operationId: input.operationId,
                tenantId: input.tenantId,
                venueId: input.venueId,
                agentIdentityId: request.agentIdentityId,
                actionName: SUPPORT_TRIAGE_APPLY_ACTION,
                capability: SUPPORT_TRIAGE_APPLY_CAPABILITY,
                mode: 'ONE_SHOT',
                scope: {
                  contractVersion: 1,
                  tenantId: input.tenantId,
                  venueId: input.venueId,
                  approvalRequestId: request.id,
                  effect: 'EXACT_TRIAGE_ONLY',
                },
                parameters,
                approvalDecisionId: decision.id,
                issueReason: `Approved exact support triage proposal ${request.id}.`,
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
  issueSupportRequestOpenPolicy: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentIdentityId: z.string().min(1),
          policyKey: agentApprovalPolicyKey,
          issueReason: z.string().trim().min(3).max(2000),
          outcomeObservationIds: z.array(z.string().min(1).max(191)).min(1).max(25),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await issueApprovalGrantAction({
            operationId: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: SUPPORT_REQUEST_OPEN_POLICY_ACTION,
            capability: SUPPORT_REQUEST_OPEN_POLICY_CAPABILITY,
            mode: 'POLICY_BACKED',
            policyKey: input.policyKey,
            scope: {
              contractVersion: 1,
              tenantId: input.tenantId,
              venueId: input.venueId,
              effect: 'DRAFT_TO_OPEN_ONLY',
            },
            constraints: defaultSupportRequestOpenPolicyConstraints(),
            issueReason: input.issueReason,
            outcomeObservationIds: input.outcomeObservationIds,
            maxUses: 1,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),
  issueSupportInternalNotePolicy: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentIdentityId: z.string().min(1),
          policyKey: agentApprovalPolicyKey,
          issueReason: z.string().trim().min(3).max(2000),
          outcomeObservationIds: z.array(z.string().min(1).max(191)).min(1).max(25),
          maxBodyChars: z.number().int().min(1).max(20_000),
          expiresAt: z.coerce.date().optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await issueApprovalGrantAction({
            operationId: input.operationId,
            tenantId: input.tenantId,
            venueId: input.venueId,
            agentIdentityId: input.agentIdentityId,
            actionName: SUPPORT_INTERNAL_NOTE_POLICY_ACTION,
            capability: SUPPORT_INTERNAL_NOTE_POLICY_CAPABILITY,
            mode: 'POLICY_BACKED',
            policyKey: input.policyKey,
            scope: {
              contractVersion: 1,
              tenantId: input.tenantId,
              venueId: input.venueId,
              effect: 'INTERNAL_NOTE_ONLY',
            },
            constraints: {
              ...defaultSupportInternalNotePolicyConstraints(),
              maxBodyChars: input.maxBodyChars,
            },
            issueReason: input.issueReason,
            outcomeObservationIds: input.outcomeObservationIds,
            maxUses: 1,
            ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
            actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          approvalGrantError(error)
        }
      }),
    ),
})
