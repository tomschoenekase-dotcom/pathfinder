import { TRPCError } from '@trpc/server'

import { db } from '@pathfinder/db'

import { router } from '../core'
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
})
