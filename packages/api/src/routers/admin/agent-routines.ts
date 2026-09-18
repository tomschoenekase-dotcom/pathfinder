import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { CreateAgentRoutineInput, SetAgentRoutineEnabledInput } from '@pathfinder/contracts'
import {
  AgentRoutineActionError,
  createAgentRoutineAction,
  db,
  setAgentRoutineEnabledAction,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

function routineError(error: unknown): never {
  if (error instanceof AgentRoutineActionError)
    throw new TRPCError({ code: error.code, message: error.message })
  throw error
}

/** Human-only routine administration. These routes manage retained definitions;
 * neither route starts a worker or invokes a model. */
export const adminAgentRoutinesRouter = router({
  listAgentRoutines: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
        })
        .strict(),
    )
    .query(async ({ input }) => {
      const routines = await db.agentRoutine.findMany({
        where: { tenantId: input.tenantId, venueId: input.venueId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        select: {
          id: true,
          routineKey: true,
          agentIdentityId: true,
          requestedOperation: true,
          intervalSeconds: true,
          maxAttempts: true,
          maxRunsPerDay: true,
          requiredWorkerRoles: true,
          requiredWorkerCapabilities: true,
          enabled: true,
          nextRunAt: true,
          lastRunAt: true,
          lastSkipReason: true,
          createdAt: true,
          updatedAt: true,
          agentIdentity: { select: { id: true, name: true, enabled: true } },
          dispatches: {
            orderBy: [{ scheduledFor: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { agentRunId: true },
          },
        },
      })
      return routines.map(({ dispatches, ...routine }) => ({
        ...routine,
        lastAgentRunId: dispatches[0]?.agentRunId ?? null,
      }))
    }),
  createAgentRoutine: adminProcedure
    .input(CreateAgentRoutineInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await createAgentRoutineAction(input, ctx.session.userId, db)
      } catch (error) {
        return routineError(error)
      }
    }),
  setAgentRoutineEnabled: adminProcedure
    .input(SetAgentRoutineEnabledInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await setAgentRoutineEnabledAction(input, ctx.session.userId, { client: db })
      } catch (error) {
        return routineError(error)
      }
    }),
})
