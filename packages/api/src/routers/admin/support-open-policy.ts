import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  defaultSupportRequestOpenPolicyConstraints,
  SUPPORT_REQUEST_OPEN_POLICY_ACTION,
  SUPPORT_REQUEST_OPEN_POLICY_CAPABILITY,
} from '@pathfinder/contracts'
import {
  ApprovalGrantActionError,
  issueApprovalGrantAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { agentApprovalPolicyKey } from './agent-approval-policy-schemas'

function approvalGrantError(error: unknown): never {
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
})
