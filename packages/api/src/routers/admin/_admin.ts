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
