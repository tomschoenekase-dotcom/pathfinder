import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentOutcomeActionError,
  db,
  recordAgentTrustSignalAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminAgentTrustSignalsRouter = router({
  recordAgentTrustSignal: adminProcedure
    .input(
      z.discriminatedUnion('signalKind', [
        z.object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentRunId: z.string().min(1),
          signalKind: z.literal('ROLLBACK'),
          relatedAgentActionId: z.string().min(1),
          summary: z.string().trim().min(1).max(2000),
          evidenceRef: z.string().trim().min(1).max(500).optional(),
        }),
        z.object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentRunId: z.string().min(1),
          signalKind: z.literal('POLICY_VIOLATION'),
          relatedAgentActionId: z.string().min(1).optional(),
          policyCode: z.string().trim().min(1).max(191),
          severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
          summary: z.string().trim().min(1).max(2000),
          evidenceRef: z.string().trim().min(1).max(500).optional(),
        }),
        z.object({
          operationId: z.string().uuid(),
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentRunId: z.string().min(1),
          signalKind: z.literal('CONFIDENCE_CALIBRATION'),
          predictionRef: z.string().trim().min(1).max(191),
          predictedConfidenceBps: z.number().int().min(0).max(10_000),
          actualCorrect: z.boolean(),
          summary: z.string().trim().min(1).max(2000),
          evidenceRef: z.string().trim().min(1).max(500).optional(),
        }),
      ]),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await recordAgentTrustSignalAction(
            {
              ...input,
              actor: {
                type: 'HUMAN',
                id: ctx.session.userId,
                role: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
        } catch (error) {
          if (error instanceof AgentOutcomeActionError) {
            throw new TRPCError({
              code:
                error.code === 'INVALID_INPUT'
                  ? 'BAD_REQUEST'
                  : error.code === 'NOT_FOUND'
                    ? 'NOT_FOUND'
                    : 'CONFLICT',
              message: error.message,
            })
          }
          throw error
        }
      }),
    ),
})
