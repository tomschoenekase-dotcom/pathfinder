import {
  AgentBridgeActionError,
  db,
  revokeAgentBridgeSessionAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { tenantScopeInput } from './agent-operations-shared'

export const adminAgentBridgeOperationsRouter = router({
  revokeAgentBridgeSession: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          sessionId: z.string().uuid(),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          return await revokeAgentBridgeSessionAction({
            ...input,
            actor: { id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
          })
        } catch (error) {
          if (error instanceof AgentBridgeActionError) {
            throw new TRPCError({ code: error.code, message: error.message })
          }
          throw error
        }
      }),
    ),
  listAgentBridgeSessions: adminProcedure.input(tenantScopeInput).query(({ input }) =>
    withTenantIsolationBypass(() =>
      db.agentBridgeSession.findMany({
        where: {
          tenantId: input.tenantId,
          ...(input.venueId ? { venueId: input.venueId } : {}),
        },
        orderBy: [{ lastHeartbeatAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          provider: true,
          label: true,
          runnerVersion: true,
          supportedModels: true,
          status: true,
          lastHeartbeatAt: true,
          expiresAt: true,
          createdAt: true,
          _count: { select: { agentRuns: true } },
        },
      }),
    ),
  ),
})
