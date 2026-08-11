import { z } from 'zod'

import { db, recordApprovalDecisionAction, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { decisionError } from './agent-operations-shared'

export const adminAgentApprovalDecisionsRouter = router({
  recordApprovalDecision: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1).nullable(),
        approvalRequestId: z.string().min(1),
        decision: z.enum(['APPROVED', 'REJECTED', 'CANCELLED']),
        reason: z.string().trim().min(1).max(2000).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const decision = await recordApprovalDecisionAction(
            {
              tenantId: input.tenantId,
              venueId: input.venueId,
              approvalRequestId: input.approvalRequestId,
              decision: input.decision,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              actor: {
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                auditRole: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          return { decision, executionTriggered: false as const }
        } catch (error) {
          return decisionError(error)
        }
      }),
    ),
})
