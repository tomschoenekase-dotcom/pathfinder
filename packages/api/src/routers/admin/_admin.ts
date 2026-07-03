import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueAnswerAnalysis, enqueueWeeklyDigest, enqueueWeeklyReport } from '@pathfinder/jobs'
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

  listVenueSessions: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        dateFrom: z.string().datetime().optional(),
        dateTo: z.string().datetime().optional(),
        notableOnly: z.boolean().optional(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(25),
      }),
    )
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const sessions = await db.visitorSession.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            ...(input.notableOnly ? { isNotable: true } : {}),
            ...(input.dateFrom || input.dateTo
              ? {
                  startedAt: {
                    ...(input.dateFrom ? { gte: new Date(input.dateFrom) } : {}),
                    ...(input.dateTo ? { lte: new Date(input.dateTo) } : {}),
                  },
                }
              : {}),
          },
          orderBy: { startedAt: 'desc' },
          take: input.limit + 1,
          ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
          select: {
            id: true,
            startedAt: true,
            lastActiveAt: true,
            messageCount: true,
            isNotable: true,
            _count: { select: { engagementResponses: true, adminNotes: true } },
          },
        })

        const hasMore = sessions.length > input.limit
        return {
          sessions: sessions.slice(0, input.limit),
          nextCursor: hasMore ? (sessions[input.limit]?.id ?? null) : null,
        }
      })
    }),

  getSessionChatlog: adminProcedure
    .input(z.object({ tenantId: z.string(), sessionId: z.string() }))
    .query(async ({ input }) => {
      return withTenantIsolationBypass(async () => {
        const session = await db.visitorSession.findFirst({
          where: { id: input.sessionId, tenantId: input.tenantId },
          select: {
            id: true,
            venueId: true,
            startedAt: true,
            lastActiveAt: true,
            isNotable: true,
            venue: { select: { name: true } },
            messages: {
              orderBy: { createdAt: 'asc' },
              select: { id: true, role: true, content: true, createdAt: true },
            },
            engagementResponses: {
              orderBy: { askedAt: 'asc' },
              select: {
                id: true,
                questionText: true,
                answerText: true,
                answerType: true,
                isAiInvented: true,
                askedAt: true,
                answeredAt: true,
              },
            },
            adminNotes: {
              orderBy: { createdAt: 'desc' },
              select: { id: true, note: true, authorId: true, createdAt: true },
            },
          },
        })

        if (!session) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' })
        }

        return session
      })
    }),

  setSessionNotable: adminProcedure
    .input(z.object({ tenantId: z.string(), sessionId: z.string(), isNotable: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await withTenantIsolationBypass(async () => {
        await db.visitorSession.updateMany({
          where: { id: input.sessionId, tenantId: input.tenantId },
          data: { isNotable: input.isNotable },
        })
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: input.isNotable ? 'admin.chatlog.marked_notable' : 'admin.chatlog.unmarked_notable',
        targetType: 'VisitorSession',
        targetId: input.sessionId,
      })

      return { ok: true }
    }),

  addChatlogNote: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        sessionId: z.string(),
        note: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const created = await withTenantIsolationBypass(async () => {
        return db.adminChatlogNote.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            sessionId: input.sessionId,
            authorId: ctx.session.userId,
            note: input.note,
          },
          select: { id: true, note: true, authorId: true, createdAt: true },
        })
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.chatlog.note_added',
        targetType: 'VisitorSession',
        targetId: input.sessionId,
        afterState: { note: input.note },
      })

      return created
    }),

  generateAnswerAnalysis: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        rangeStart: z.string().datetime(),
        rangeEnd: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const snapshot = await withTenantIsolationBypass(async () => {
        return db.answerAnalysisSnapshot.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            rangeStart: new Date(input.rangeStart),
            rangeEnd: new Date(input.rangeEnd),
            status: 'GENERATING',
            createdBy: ctx.session.userId,
          },
          select: { id: true },
        })
      })

      await enqueueAnswerAnalysis({
        tenantId: input.tenantId,
        venueId: input.venueId,
        rangeStart: input.rangeStart,
        rangeEnd: input.rangeEnd,
        snapshotId: snapshot.id,
      })

      return { snapshotId: snapshot.id }
    }),

  listAnswerAnalyses: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string() }))
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () =>
        db.answerAnalysisSnapshot.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            status: true,
            rangeStart: true,
            rangeEnd: true,
            answerCount: true,
            generatedAt: true,
          },
        }),
      ),
    ),

  getAnswerAnalysis: adminProcedure
    .input(z.object({ tenantId: z.string(), snapshotId: z.string() }))
    .query(async ({ input }) => {
      const snapshot = await withTenantIsolationBypass(async () =>
        db.answerAnalysisSnapshot.findFirst({
          where: { id: input.snapshotId, tenantId: input.tenantId },
        }),
      )
      if (!snapshot) throw new TRPCError({ code: 'NOT_FOUND', message: 'Analysis not found' })
      return snapshot
    }),

  generateWeeklyReportDraft: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        venueId: z.string(),
        weekStart: z.string().datetime(),
        weekEnd: z.string().datetime(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const weekStart = new Date(input.weekStart)
      const weekEnd = new Date(input.weekEnd)

      const report = await withTenantIsolationBypass(async () => {
        const existing = await db.weeklyReport.findUnique({
          where: { venueId_weekStart: { venueId: input.venueId, weekStart } },
          select: { id: true, status: true },
        })

        if (existing?.status === 'PUBLISHED') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'This week is already published. Unpublish is not supported - create a correction note instead.',
          })
        }

        if (existing) {
          return db.weeklyReport.update({
            where: { id: existing.id },
            data: { status: 'GENERATING', error: null },
            select: { id: true },
          })
        }

        return db.weeklyReport.create({
          data: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            weekStart,
            weekEnd,
            status: 'GENERATING',
            createdBy: ctx.session.userId,
          },
          select: { id: true },
        })
      })

      await enqueueWeeklyReport({
        tenantId: input.tenantId,
        venueId: input.venueId,
        weekStart: input.weekStart,
        weekEnd: input.weekEnd,
        reportId: report.id,
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.report.draft_generated',
        targetType: 'WeeklyReport',
        targetId: report.id,
      })

      return { reportId: report.id }
    }),

  listWeeklyReports: adminProcedure
    .input(z.object({ tenantId: z.string(), venueId: z.string() }))
    .query(async ({ input }) =>
      withTenantIsolationBypass(async () =>
        db.weeklyReport.findMany({
          where: { tenantId: input.tenantId, venueId: input.venueId },
          orderBy: { weekStart: 'desc' },
          select: {
            id: true,
            weekStart: true,
            weekEnd: true,
            status: true,
            title: true,
            publishedAt: true,
            updatedAt: true,
          },
        }),
      ),
    ),

  getWeeklyReport: adminProcedure
    .input(z.object({ tenantId: z.string(), reportId: z.string() }))
    .query(async ({ input }) => {
      const report = await withTenantIsolationBypass(async () =>
        db.weeklyReport.findFirst({ where: { id: input.reportId, tenantId: input.tenantId } }),
      )
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
      return report
    }),

  updateWeeklyReportDraft: adminProcedure
    .input(
      z.object({
        tenantId: z.string(),
        reportId: z.string(),
        title: z.string().min(1).max(200).optional(),
        content: z.string().min(1).max(10_000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await withTenantIsolationBypass(async () =>
        db.weeklyReport.findFirst({
          where: { id: input.reportId, tenantId: input.tenantId },
          select: { status: true },
        }),
      )
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
      if (existing.status === 'PUBLISHED') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Published reports cannot be edited.' })
      }

      await withTenantIsolationBypass(async () => {
        await db.weeklyReport.updateMany({
          where: { id: input.reportId, tenantId: input.tenantId },
          data: {
            content: input.content,
            ...(input.title !== undefined ? { title: input.title } : {}),
          },
        })
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.report.edited',
        targetType: 'WeeklyReport',
        targetId: input.reportId,
      })

      return { ok: true }
    }),

  publishWeeklyReport: adminProcedure
    .input(z.object({ tenantId: z.string(), reportId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await withTenantIsolationBypass(async () =>
        db.weeklyReport.findFirst({
          where: { id: input.reportId, tenantId: input.tenantId },
          select: { status: true, content: true },
        }),
      )
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
      if (existing.status !== 'DRAFT') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Only a draft report can be published.',
        })
      }
      if (!existing.content) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Report has no content to publish.' })
      }

      await withTenantIsolationBypass(async () => {
        await db.weeklyReport.updateMany({
          where: { id: input.reportId, tenantId: input.tenantId },
          data: { status: 'PUBLISHED', publishedAt: new Date() },
        })
      })

      await writeAuditLog({
        tenantId: input.tenantId,
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.report.published',
        targetType: 'WeeklyReport',
        targetId: input.reportId,
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
