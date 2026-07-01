import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueWeeklyDigest } from '@pathfinder/jobs'
import { adminProcedure } from '../../trpc'
import { router } from '../../core'

function startOfCurrentUtcWeek(date: Date): Date {
  const result = new Date(date)
  const day = result.getUTCDay()
  const daysFromMonday = (day + 6) % 7

  result.setUTCDate(result.getUTCDate() - daysFromMonday)
  result.setUTCHours(0, 0, 0, 0)

  return result
}

function endOfUtcWeek(weekStart: Date): Date {
  const result = new Date(weekStart)

  result.setUTCDate(result.getUTCDate() + 6)
  result.setUTCHours(23, 59, 59, 999)

  return result
}

export const adminRouter = router({
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

  /**
   * Full detail for a single client (tenant): identity, active members, every
   * venue with its POI count, and a thin 7-day engagement summary. Cross-tenant,
   * so it runs under the isolation bypass.
   *
   * NOTE: engagement here is intentionally minimal (raw counts). The analytics
   * model is expected to be reworked soon — keep this block small and isolated
   * so it can be swapped without touching the rest of the procedure.
   */
  getClient: adminProcedure
    .input(z.object({ tenantId: z.string().min(1) }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const tenant = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            status: true,
            planTier: true,
            createdAt: true,
            memberships: {
              where: { status: 'ACTIVE' },
              select: {
                id: true,
                role: true,
                user: { select: { email: true, fullName: true } },
              },
            },
          },
        })

        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const venues = await db.venue.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            slug: true,
            category: true,
            guideMode: true,
            isActive: true,
            createdAt: true,
            _count: { select: { places: true } },
          },
        })

        const last7 = new Date()
        last7.setUTCDate(last7.getUTCDate() - 7)

        const [sessions7d, messages7d] = await Promise.all([
          db.visitorSession.count({
            where: { tenantId: input.tenantId, startedAt: { gte: last7 } },
          }),
          db.message.count({
            where: { tenantId: input.tenantId, createdAt: { gte: last7 } },
          }),
        ])

        return {
          tenant,
          venues,
          engagement7d: { sessions: sessions7d, messages: messages7d },
        }
      })
    }),

  /**
   * One venue within a client, with its POIs and a thin engagement summary.
   * Cross-tenant (bypass). Same analytics caveat as getClient — keep it minimal.
   */
  getClientVenue: adminProcedure
    .input(z.object({ tenantId: z.string().min(1), venueId: z.string().min(1) }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const venue = await db.venue.findFirst({
          where: { id: input.venueId, tenantId: input.tenantId },
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            category: true,
            guideMode: true,
            isActive: true,
            defaultCenterLat: true,
            defaultCenterLng: true,
            aiGuideName: true,
            aiTone: true,
            createdAt: true,
            _count: { select: { places: true } },
          },
        })

        if (!venue) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        }

        const places = await db.place.findMany({
          where: { venueId: input.venueId, tenantId: input.tenantId },
          orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            type: true,
            itemType: true,
            areaName: true,
            isActive: true,
            lat: true,
            lng: true,
            importanceScore: true,
          },
        })

        const last7 = new Date()
        last7.setUTCDate(last7.getUTCDate() - 7)

        const [sessions7d, messages7d] = await Promise.all([
          db.visitorSession.count({
            where: { tenantId: input.tenantId, venueId: input.venueId, startedAt: { gte: last7 } },
          }),
          db.message.count({
            where: {
              tenantId: input.tenantId,
              createdAt: { gte: last7 },
              session: { venueId: input.venueId },
            },
          }),
        ])

        return {
          venue,
          places,
          engagement7d: { sessions: sessions7d, messages: messages7d },
        }
      })
    }),

  getClientAnalytics: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        days: z.number().int().min(1).max(90).default(30),
      }),
    )
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const startDate = new Date()
        startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))
        startDate.setUTCHours(0, 0, 0, 0)

        const [
          tenant,
          totalSessions,
          totalMessages,
          uniqueVisitors,
          recentSessions,
          questionClusters,
        ] = await Promise.all([
          db.tenant.findUnique({
            where: { id: input.tenantId },
            select: { id: true, name: true, slug: true },
          }),
          db.visitorSession.count({
            where: { tenantId: input.tenantId, startedAt: { gte: startDate } },
          }),
          db.message.count({
            where: { tenantId: input.tenantId, createdAt: { gte: startDate } },
          }),
          db.visitorSession.findMany({
            where: {
              tenantId: input.tenantId,
              startedAt: { gte: startDate },
              visitorId: { not: null },
            },
            select: { visitorId: true },
            distinct: ['visitorId'],
          }),
          db.visitorSession.findMany({
            where: { tenantId: input.tenantId, startedAt: { gte: startDate } },
            orderBy: { startedAt: 'desc' },
            take: 20,
            select: {
              id: true,
              startedAt: true,
              lastActiveAt: true,
              messageCount: true,
              visitorId: true,
              messages: {
                orderBy: { createdAt: 'asc' },
                select: { id: true, role: true, content: true, createdAt: true, topic: true },
              },
            },
          }),
          db.questionCluster.findMany({
            where: { tenantId: input.tenantId, windowStart: { gte: startDate } },
            orderBy: { count: 'desc' },
            take: 20,
            select: {
              id: true,
              kind: true,
              canonicalText: true,
              count: true,
              examples: true,
              windowStart: true,
              venue: { select: { name: true } },
            },
          }),
        ])

        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        return {
          tenant,
          stats: {
            totalSessions,
            totalMessages,
            uniqueVisitors: uniqueVisitors.length,
          },
          recentSessions,
          questionClusters,
        }
      })
    }),

  listClients: adminProcedure.query(async () => {
    return withTenantIsolationBypass(() =>
      db.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        include: {
          memberships: {
            where: { status: 'ACTIVE' },
            include: { user: true },
          },
        },
      }),
    )
  }),

  /**
   * Platform-admin-only mutation to set or clear a tenant's next payment due
   * date. Visible read-only to operators; editable for admins viewing a tenant.
   */
  setTenantPaymentDue: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        nextPaymentDue: z.string().datetime().nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      await withTenantIsolationBypass(async () => {
        await db.tenant.update({
          where: { id: input.tenantId },
          data: {
            nextPaymentDue: input.nextPaymentDue ? new Date(input.nextPaymentDue) : null,
          },
        })
      })

      return { ok: true }
    }),

  createClient: adminProcedure
    .input(
      z.object({
        orgId: z.string().min(1),
        name: z.string().min(1),
        slug: z.string().min(1),
        userId: z.string().min(1),
        userEmail: z.string().email(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await withTenantIsolationBypass(() =>
        db.tenant.findUnique({ where: { id: input.orgId } }),
      )
      if (existing) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'A client with this org ID already exists',
        })
      }

      await withTenantIsolationBypass(async () => {
        await db.tenant.create({
          data: { id: input.orgId, name: input.name, slug: input.slug },
        })

        await db.user.upsert({
          where: { id: input.userId },
          create: { id: input.userId, email: input.userEmail },
          update: { email: input.userEmail },
        })

        await db.tenantMembership.upsert({
          where: { tenantId_userId: { tenantId: input.orgId, userId: input.userId } },
          create: {
            tenantId: input.orgId,
            userId: input.userId,
            role: 'OWNER',
            status: 'ACTIVE',
            joinedAt: new Date(),
          },
          update: { role: 'OWNER', status: 'ACTIVE' },
        })
      })

      await writeAuditLog({
        tenantId: input.orgId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.created',
        targetType: 'Tenant',
        targetId: input.orgId,
        afterState: {
          id: input.orgId,
          name: input.name,
          slug: input.slug,
          ownerUserId: input.userId,
        },
      })

      return { ok: true }
    }),

  updateClientStatus: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        status: z.enum(['ACTIVE', 'SUSPENDED', 'TRIAL']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await withTenantIsolationBypass(async () => {
        const existing = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true, status: true },
        })

        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const tenant = await db.tenant.update({
          where: { id: input.tenantId },
          data: { status: input.status },
          select: { id: true, status: true },
        })

        return { existing, tenant }
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.status_updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: updated.existing,
        afterState: updated.tenant,
      })

      return { ok: true }
    }),

  updateClientPlanTier: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        planTier: z.enum(['free', 'pro', 'enterprise']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const updated = await withTenantIsolationBypass(async () => {
        const existing = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true, planTier: true },
        })

        if (!existing) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const tenant = await db.tenant.update({
          where: { id: input.tenantId },
          data: { planTier: input.planTier },
          select: { id: true, planTier: true },
        })

        return { existing, tenant }
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.client.plan_updated',
        targetType: 'Tenant',
        targetId: input.tenantId,
        beforeState: updated.existing,
        afterState: updated.tenant,
      })

      return { ok: true }
    }),

  triggerDigest: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date()
      const weekStart = startOfCurrentUtcWeek(now)
      const weekEnd = endOfUtcWeek(weekStart)

      const digest = await withTenantIsolationBypass(async () => {
        const tenant = await db.tenant.findUnique({
          where: { id: input.tenantId },
          select: { id: true },
        })

        if (!tenant) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })
        }

        const existing = await db.weeklyDigest.findUnique({
          where: {
            tenantId_weekStart: {
              tenantId: input.tenantId,
              weekStart,
            },
          },
          select: {
            id: true,
          },
        })

        if (existing) {
          return existing
        }

        return db.weeklyDigest.create({
          data: {
            tenantId: input.tenantId,
            weekStart,
            weekEnd,
            status: 'PENDING',
          },
          select: {
            id: true,
          },
        })
      })

      await enqueueWeeklyDigest({
        tenantId: input.tenantId,
        weekStart: weekStart.toISOString(),
        weekEnd: weekEnd.toISOString(),
        digestId: digest.id,
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.digest.triggered',
        targetType: 'WeeklyDigest',
        targetId: digest.id,
      })

      return { digestId: digest.id }
    }),
})
