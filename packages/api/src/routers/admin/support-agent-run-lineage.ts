import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  linkSupportRequestAgentRunAction,
  SupportAgentRunLineageError,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult } from './agent-operations-shared'

const exactScope = z.object({
  tenantId: z.string().min(1),
  venueId: z.string().min(1),
  requestId: z.string().min(1),
})

function lineageError(error: unknown): never {
  if (error instanceof SupportAgentRunLineageError) {
    throw new TRPCError({
      code: error.code === 'INVALID_INPUT' ? 'BAD_REQUEST' : error.code,
      message: error.message,
    })
  }
  throw error
}

export const adminSupportAgentRunLineageRouter = router({
  linkSupportAgentRun: adminProcedure
    .input(
      exactScope.extend({
        operationId: z.string().uuid(),
        agentRunId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await linkSupportRequestAgentRunAction(
          {
            ...input,
            actor: {
              actorType: 'HUMAN',
              actorId: ctx.session.userId,
              auditRole: 'PLATFORM_ADMIN',
            },
          },
          ctx.db,
        )
      } catch (error) {
        return lineageError(error)
      }
    }),

  listSupportAgentRunLineages: adminProcedure
    .input(exactScope.merge(pageInput))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const request = await db.supportRequest.findFirst({
          where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
          select: { id: true },
        })
        if (!request)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Support request not found' })
        const rows = await db.supportAgentRunLineage.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            supportRequestId: request.id,
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            supportRequestId: true,
            requestVersion: true,
            agentRunId: true,
            linkedRunStatus: true,
            linkedRunCompletedAt: true,
            linkedByKind: true,
            linkedById: true,
            linkedByRole: true,
            createdAt: true,
            agentRun: {
              select: {
                id: true,
                runType: true,
                requestedOperation: true,
                agentIdentityId: true,
                createdAt: true,
                completedAt: true,
              },
            },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),
})
