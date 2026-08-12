import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  db,
  prepareWeeklyDigestIntentAction,
  WeeklyDigestIntentActionError,
  withTenantIsolationBypass,
} from '@pathfinder/db'
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

      try {
        const digest = await withTenantIsolationBypass(() =>
          prepareWeeklyDigestIntentAction(
            {
              tenantId: input.tenantId,
              weekStart,
              weekEnd,
              actor: { type: 'HUMAN', id: ctx.session.userId, role: 'PLATFORM_ADMIN' },
            },
            db,
          ),
        )
        if (digest.enqueueAllowed) {
          await enqueueWeeklyDigest({
            tenantId: input.tenantId,
            weekStart: weekStart.toISOString(),
            weekEnd: weekEnd.toISOString(),
            digestId: digest.id,
          })
        }
        return { digestId: digest.id }
      } catch (error) {
        if (error instanceof WeeklyDigestIntentActionError) {
          throw new TRPCError({
            code:
              error.code === 'NOT_FOUND'
                ? 'NOT_FOUND'
                : error.code === 'CONFLICT'
                  ? 'CONFLICT'
                  : 'BAD_REQUEST',
            message: error.message,
          })
        }
        throw error
      }
    }),
})
