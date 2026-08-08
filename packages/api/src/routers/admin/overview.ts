import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminOverviewRouter = router({
  ping: adminProcedure.query(() => ({
    ok: true,
    scope: 'admin',
  })),

  /**
   * Platform-wide operational snapshot for the admin home. All counts are
   * cross-tenant, so the whole block runs under the tenant-isolation bypass —
   * permitted here because this is an admin.* procedure.
   */

  overview: adminProcedure.query(async () => {
    return withTenantIsolationBypass(async () => {
      const now = new Date()
      const last7 = new Date(now)
      last7.setUTCDate(now.getUTCDate() - 7)

      const [
        tenantsByStatus,
        venueCount,
        placeCount,
        sessions7d,
        messages7d,
        failedJobs7d,
        recentJobs,
        newTenants,
      ] = await Promise.all([
        db.tenant.groupBy({ by: ['status'], _count: { _all: true } }),
        db.venue.count({ where: { isActive: true } }),
        db.place.count({ where: { isActive: true } }),
        db.visitorSession.count({ where: { startedAt: { gte: last7 } } }),
        db.message.count({ where: { createdAt: { gte: last7 } } }),
        db.jobRecord.count({ where: { status: 'FAILED', createdAt: { gte: last7 } } }),
        db.jobRecord.findMany({
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            queue: true,
            jobName: true,
            status: true,
            tenantId: true,
            error: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
          },
        }),
        db.tenant.findMany({
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { id: true, name: true, slug: true, status: true, createdAt: true },
        }),
      ])

      const statusCounts: Record<'ACTIVE' | 'SUSPENDED' | 'TRIAL', number> = {
        ACTIVE: 0,
        SUSPENDED: 0,
        TRIAL: 0,
      }
      for (const row of tenantsByStatus) {
        statusCounts[row.status] = row._count._all
      }

      return {
        tenants: {
          total: statusCounts.ACTIVE + statusCounts.SUSPENDED + statusCounts.TRIAL,
          byStatus: statusCounts,
          recent: newTenants,
        },
        content: { venueCount, placeCount },
        engagement7d: { sessions: sessions7d, messages: messages7d },
        jobs: { failed7d: failedJobs7d, recent: recentJobs },
      }
    })
  }),
})
