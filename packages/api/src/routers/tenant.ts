import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db } from '@pathfinder/db'

import { router } from '../core'
import { requireRole } from '../middleware/require-role'
import { tenantProcedure } from '../trpc'

export const tenantRouter = router({
  /**
   * Returns the current tenant's settings and full non-removed member list.
   * Used by the dashboard settings page.
   */
  getSettings: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId

    const [tenant, members] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          planTier: true,
          status: true,
          nextPaymentDue: true,
          engagementMode: true,
        },
      }),
      db.tenantMembership.findMany({
        where: { tenantId, status: { not: 'REMOVED' } },
        select: {
          id: true,
          role: true,
          status: true,
          joinedAt: true,
          createdAt: true,
          user: {
            select: { id: true, email: true, fullName: true, avatarUrl: true },
          },
        },
        orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
      }),
    ])

    if (!tenant) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Tenant not found' })
    }

    return { tenant, members }
  }),

  setEngagementMode: tenantProcedure
    .use(requireRole('MANAGER'))
    .input(z.object({ mode: z.enum(['STOIC', 'BALANCED', 'CURIOUS']) }).strict())
    .mutation(async ({ ctx, input }) => {
      await db.tenant.update({
        where: { id: ctx.session.activeTenantId },
        data: { engagementMode: input.mode },
      })

      return { ok: true }
    }),
})
