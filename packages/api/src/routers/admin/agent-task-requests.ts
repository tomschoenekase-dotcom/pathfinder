import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  AgentTaskActionError,
  createAgentTaskAction,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { env } from '@pathfinder/config'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminAgentTaskRequestsRouter = router({
  createAgentTask: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        agentIdentityId: z.string().min(1),
        prompt: z.string().trim().min(1).max(10_000),
      }),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        try {
          const result = await createAgentTaskAction(
            {
              ...input,
              actor: {
                actorType: 'HUMAN',
                actorId: ctx.session.userId,
                auditRole: 'PLATFORM_ADMIN',
              },
            },
            db,
          )
          const dispatch = await enqueueAgentRun(
            { tenantId: input.tenantId, runId: result.run.id },
            { enabled: env.AGENT_RUNNER_ENABLED },
          )
          return { ...result, executionTriggered: dispatch.enqueued }
        } catch (error) {
          if (error instanceof AgentTaskActionError) {
            throw new TRPCError({ code: error.code, message: error.message })
          }
          throw error
        }
      }),
    ),
})
