import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass, writeAuditLog } from '@pathfinder/db'
import { enqueueWeeklyDigest } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminAiProcedure } from '../../trpc'
import { endOfUtcWeek, startOfCurrentUtcWeek } from './helpers'

export const adminDigestRouter = router({
  triggerDigest: adminAiProcedure
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
