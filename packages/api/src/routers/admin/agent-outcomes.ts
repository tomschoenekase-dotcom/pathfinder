import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentOutcomeActionError,
  db,
  recordAgentOutcomeAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'

export const adminAgentOutcomesRouter = router({
  listAgentOutcomeObservations: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentRunId: z.string().min(1).optional(),
        agentIdentityId: z.string().min(1).optional(),
        signalKind: z
          .enum([
            'HUMAN_REVIEW',
            'BUSINESS_OUTCOME',
            'QUALITY_EVALUATION',
            'CUSTOMER_SIGNAL',
            'SYSTEM_OBSERVATION',
          ])
          .optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentOutcomeObservation.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...(input.signalKind ? { signalKind: input.signalKind } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            venueId: true,
            agentRunId: true,
            agentIdentityId: true,
            signalKind: true,
            verdict: true,
            summary: true,
            evidenceRef: true,
            taskClass: true,
            modelProvider: true,
            modelName: true,
            actorType: true,
            actorId: true,
            createdAt: true,
            agentIdentity: { select: { id: true, name: true } },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),

  recordAgentRunOutcome: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        agentRunId: z.string().min(1),
        verdict: z.enum(['POSITIVE', 'MIXED', 'NEGATIVE', 'INCONCLUSIVE']),
        summary: z.string().trim().min(1).max(2000),
        evidenceRef: z.string().trim().min(1).max(500).optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await recordAgentOutcomeAction(
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
