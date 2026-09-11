import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AgentSourceAssignment } from '@pathfinder/contracts'

import {
  AgentTaskActionError,
  configureIntakeSourceAgentRouting,
  IntakeSourceAgentRoutingInput,
  IntakeSourceAgentRoutingError,
  createAgentTaskAction,
  db,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { env } from '@pathfinder/config'
import { enqueueAgentRun } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult } from './agent-operations-shared'

export const adminAgentTaskRequestsRouter = router({
  listIntakeSourceAgentRoutingCandidates: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
        })
        .merge(pageInput)
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: input.tenantId },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found.' })
      const rows = await ctx.db.agentIdentity.findMany({
        where: {
          tenantId: input.tenantId,
          enabled: true,
          agentType: 'CONTENT',
          OR: [
            { venueId: input.venueId, accessScope: 'VENUE' },
            { venueId: null, accessScope: 'CLIENT' },
          ],
          accessCapabilities: { hasEvery: ['intake.read', 'content.draft'] },
          autonomousActions: { has: 'content.prepare-draft' },
          autonomyLevel: { not: 'READ_ONLY' },
          defaultProvider: { not: null },
          defaultModel: { not: null },
          ...createdBefore(input.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          name: true,
          agentType: true,
          accessScope: true,
          enabled: true,
          accessCapabilities: true,
          autonomyLevel: true,
          autonomousActions: true,
          defaultProvider: true,
          defaultModel: true,
          createdAt: true,
        },
      })
      return pageResult(rows, input.limit)
    }),
  getIntakeSourceAgentRouting: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().trim().min(1).max(191),
          venueId: z.string().trim().min(1).max(191),
        })
        .strict(),
    )
    .query(({ ctx, input }) =>
      ctx.db.intakeSourceAgentRoutingPolicy.findUnique({
        where: { tenantId: input.tenantId, tenantId_venueId: input },
      }),
    ),
  configureIntakeSourceAgentRouting: adminProcedure
    .input(IntakeSourceAgentRoutingInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await configureIntakeSourceAgentRouting(input, ctx.session.userId, ctx.db)
      } catch (error) {
        if (error instanceof IntakeSourceAgentRoutingError)
          throw new TRPCError({ code: error.code, message: error.message })
        throw error
      }
    }),

  createAgentTask: adminProcedure
    .input(
      z.object({
        operationId: z.string().uuid(),
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
        agentIdentityId: z.string().min(1),
        prompt: z.string().trim().min(1).max(10_000),
        promptIdentity: z.string().trim().min(1).max(191).optional(),
        sourceAssignment: AgentSourceAssignment.optional(),
        prospectScope: z
          .discriminatedUnion('mode', [
            z.object({ mode: z.literal('ALL') }).strict(),
            z
              .object({
                mode: z.literal('TERRITORIES'),
                territoryIds: z.array(z.string().trim().min(1).max(191)).min(1).max(100),
              })
              .strict(),
          ])
          .optional(),
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
