import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'

export const adminAgentIdentityReadsRouter = router({
  listAgentIdentities: adminProcedure
    .input(tenantScopeInput.merge(pageInput).extend({ enabled: z.boolean().optional() }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rows = await db.agentIdentity.findMany({
          where: {
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            identityKey: true,
            name: true,
            description: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            enabled: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            venue: { select: { id: true, name: true } },
            _count: { select: { runs: true, approvalRequests: true } },
          },
        })
        return pageResult(rows, input.limit)
      }),
    ),
  getAgentIdentity: adminProcedure
    .input(tenantScopeInput.extend({ agentIdentityId: z.string().min(1) }))
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const identity = await db.agentIdentity.findFirst({
          where: {
            id: input.agentIdentityId,
            tenantId: input.tenantId,
            ...(input.venueId ? { venueId: input.venueId } : {}),
          },
          select: {
            id: true,
            tenantId: true,
            venueId: true,
            identityKey: true,
            name: true,
            description: true,
            agentType: true,
            accessScope: true,
            accessCapabilities: true,
            autonomyLevel: true,
            autonomousActions: true,
            defaultProvider: true,
            defaultModel: true,
            enabled: true,
            createdBy: true,
            createdAt: true,
            updatedAt: true,
            venue: { select: { id: true, name: true } },
            _count: { select: { runs: true, actions: true, approvalRequests: true } },
          },
        })
        if (!identity)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Agent identity not found' })
        return identity
      }),
    ),
})
