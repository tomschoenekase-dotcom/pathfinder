import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION,
  INTAKE_V1_PACKAGE_DRAFT_CAPABILITY,
  IntakeV1PackageDraftApplyParameters,
  IntakeV1PackageDraftProposalApprovalSnapshot,
} from '@pathfinder/contracts'
import {
  db,
  issueApprovalGrantInTransaction,
  recordApprovalDecisionInTransaction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminIntakeV1PackageDraftApprovalRouter = router({
  decideIntakeV1PackageDraftProposal: adminProcedure
    .input(
      z
        .object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1).max(191),
          venueId: z.string().min(1).max(191),
          approvalRequestId: z.string().min(1).max(191),
          decision: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
          reason: z.string().trim().min(1).max(2_000).optional(),
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
                proposedAction: INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION,
              },
              select: {
                id: true,
                agentIdentityId: true,
                scopeSnapshot: true,
                expiresAt: true,
                decision: { select: { id: true, decision: true, decidedById: true, reason: true } },
              },
            })
            const snapshot = IntakeV1PackageDraftProposalApprovalSnapshot.safeParse(
              request?.scopeSnapshot,
            )
            if (!request)
              throw new TRPCError({ code: 'NOT_FOUND', message: 'Approval request not found.' })
            if (
              !snapshot.success ||
              snapshot.data.tenantId !== input.tenantId ||
              snapshot.data.venueId !== input.venueId
            )
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'V1 package proposal identity is invalid.',
              })
            const revision = await tx.intakeV1SubmissionRevision.findFirst({
              where: {
                submissionId: snapshot.data.submissionId,
                revision: snapshot.data.revision,
                tenantId: input.tenantId,
                venueId: input.venueId,
                manifestHash: snapshot.data.manifestHash,
              },
              select: { id: true },
            })
            if (input.decision === 'APPROVED' && !revision)
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'V1 revision changed before approval.',
              })
            if (
              request.decision &&
              (request.decision.decision !== input.decision ||
                request.decision.decidedById !== ctx.session.userId ||
                request.decision.reason !== (input.reason ?? null))
            )
              throw new TRPCError({
                code: 'CONFLICT',
                message: 'Approval request already has a different decision.',
              })
            const decision =
              request.decision ??
              (await recordApprovalDecisionInTransaction(tx, {
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
              }))
            if (input.decision !== 'APPROVED')
              return { decision, approvalGrant: null, executionTriggered: false as const }
            const parameters = IntakeV1PackageDraftApplyParameters.parse({
              clientId: snapshot.data.tenantId,
              venueId: snapshot.data.venueId,
              submissionId: snapshot.data.submissionId,
              revision: snapshot.data.revision,
              manifestHash: snapshot.data.manifestHash,
              candidateHash: snapshot.data.candidateHash,
              payloadHash: snapshot.data.payloadHash,
              selectionHash: snapshot.data.selectionHash,
              selectedMemberIds: snapshot.data.selectedMemberIds,
              partialAcknowledged: snapshot.data.partialAcknowledged,
              draftOperationId: snapshot.data.draftOperationId,
            })
            const approvalGrant = await issueApprovalGrantInTransaction(tx, {
              operationId: input.operationId,
              tenantId: input.tenantId,
              venueId: input.venueId,
              agentIdentityId: request.agentIdentityId,
              actionName: INTAKE_V1_PACKAGE_DRAFT_APPLY_ACTION,
              capability: INTAKE_V1_PACKAGE_DRAFT_CAPABILITY,
              mode: 'ONE_SHOT',
              scope: {
                contractVersion: 1,
                tenantId: input.tenantId,
                venueId: input.venueId,
                approvalRequestId: request.id,
                effect: 'EXACT_INTAKE_V1_PACKAGE_DRAFT_ONLY',
              },
              parameters,
              approvalDecisionId: decision.id,
              issueReason: `Approved exact V1 package draft proposal ${request.id}.`,
              ...(request.expiresAt ? { expiresAt: request.expiresAt } : {}),
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            })
            return { decision, approvalGrant, executionTriggered: false as const }
          })
        } catch (error) {
          if (error instanceof TRPCError) throw error
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'V1 package draft approval could not be recorded.',
          })
        }
      }),
    ),
})
