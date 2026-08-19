import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { buildOnboardingMilestoneRollup } from '@pathfinder/contracts'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

const ONBOARDING_METRIC_EVENT_LIMIT = 1000

export const adminEvaluationOnboardingReadsRouter = router({
  getOnboardingMilestoneRollup: adminProcedure
    .input(
      z
        .object({
          tenantId: z.string().min(1),
          venueId: z.string().min(1),
          from: z.string().datetime({ offset: true }),
          to: z.string().datetime({ offset: true }),
        })
        .superRefine((input, context) => {
          const duration = new Date(input.to).getTime() - new Date(input.from).getTime()
          if (duration <= 0 || duration > 366 * 24 * 60 * 60 * 1000)
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['to'],
              message: 'Metrics window must be positive and no longer than 366 days',
            })
        }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const from = new Date(input.from)
        const to = new Date(input.to)
        const [venue, rows] = await Promise.all([
          db.venue.findFirst({
            where: { id: input.venueId, tenantId: input.tenantId },
            select: { id: true },
          }),
          db.onboardingMilestoneEvent.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              occurredAt: { gte: from, lt: to },
            },
            orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
            take: ONBOARDING_METRIC_EVENT_LIMIT + 1,
            select: {
              id: true,
              eventType: true,
              occurredAt: true,
              category: true,
              durationMs: true,
            },
          }),
        ])
        if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
        return buildOnboardingMilestoneRollup({
          events: rows.slice(0, ONBOARDING_METRIC_EVENT_LIMIT).map((row) => ({
            ...row,
            eventType: row.eventType as Parameters<
              typeof buildOnboardingMilestoneRollup
            >[0]['events'][number]['eventType'],
          })),
          from,
          to,
          eventLimit: ONBOARDING_METRIC_EVENT_LIMIT,
          truncated: rows.length > ONBOARDING_METRIC_EVENT_LIMIT,
        })
      }),
    ),

  listOnboardingEvaluationPackages: adminProcedure
    .input(
      z.object({
        tenantId: z.string().min(1),
        venueId: z.string().min(1),
      }),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        db.venuePackage.findMany({
          where: {
            tenantId: input.tenantId,
            venueId: input.venueId,
            status: 'APPROVED',
          },
          orderBy: [{ approvedAt: 'desc' }, { id: 'desc' }],
          take: 50,
          select: { id: true, payloadHash: true, approvedAt: true },
        }),
      ),
    ),
})
