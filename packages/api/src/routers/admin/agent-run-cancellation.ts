import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentRunCancellationError,
  db,
  requestAgentRunCancellationAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminAgentRunCancellationRouter = router({
  requestAgentRunCancellation: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          agentRunId: z.string().min(1),
          reason: z.string().trim().min(1).max(500),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await withTenantIsolationBypass(() =>
          requestAgentRunCancellationAction(
            {
              ...input,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
      } catch (error) {
        if (error instanceof AgentRunCancellationError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'BAD_REQUEST',
            message: error.message,
          })
        }
        throw error
      }
    }),
})
