import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { createdBefore, pageInput, pageResult, tenantScopeInput } from './agent-operations-shared'

export const adminAgentApprovalPolicyReadsRouter = router({
  listAgentApprovalPolicies: adminProcedure
    .input(
      tenantScopeInput.merge(pageInput).extend({
        agentIdentityId: z.string().min(1).optional(),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const now = new Date()
        const rows = await db.approvalGrant.findMany({
          where: {
            tenantId: input.tenantId,
            mode: 'POLICY_BACKED',
            ...(input.venueId ? { venueId: input.venueId } : {}),
            ...(input.agentIdentityId ? { agentIdentityId: input.agentIdentityId } : {}),
            ...createdBefore(input.cursor),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            operationId: true,
            tenantId: true,
            venueId: true,
            policyKey: true,
            agentIdentityId: true,
            actionName: true,
            capability: true,
            scope: true,
            constraints: true,
            issueReason: true,
            maxUses: true,
            useCount: true,
            notBefore: true,
            expiresAt: true,
            revokedAt: true,
            revokeReason: true,
            createdById: true,
            createdAt: true,
            updatedAt: true,
            agentIdentity: { select: { id: true, name: true, enabled: true } },
            authorityEvidence: {
              orderBy: { createdAt: 'desc' },
              select: {
                createdAt: true,
                outcomeObservation: {
                  select: {
                    id: true,
                    agentRunId: true,
                    agentIdentityId: true,
                    signalKind: true,
                    verdict: true,
                    summary: true,
                    evidenceRef: true,
                    taskClass: true,
                    modelProvider: true,
                    modelName: true,
                    createdAt: true,
                  },
                },
              },
            },
            _count: { select: { consumptions: true } },
          },
        })
        const page = pageResult(rows, input.limit)
        return {
          ...page,
          items: page.items.map((grant) => ({
            ...grant,
            state:
              grant.revokedAt !== null
                ? ('REVOKED' as const)
                : grant.expiresAt && grant.expiresAt <= now
                  ? ('EXPIRED' as const)
                  : grant.maxUses !== null && grant.useCount >= grant.maxUses
                    ? ('EXHAUSTED' as const)
                    : grant.notBefore > now
                      ? ('SCHEDULED' as const)
                      : ('ACTIVE' as const),
          })),
        }
      }),
    ),
})
