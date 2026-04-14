import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@pathfinder/analytics'

import { router } from '../core'
import { publicProcedure, tenantProcedure } from '../trpc'

const analyticsTrackEventInput = z
  .object({
    sessionId: z.string().uuid(),
    venueId: z.string().cuid(),
    eventType: z.enum(ANALYTICS_EVENT_TYPES),
    placeId: z.string().cuid().optional(),
    metadata: z.record(z.unknown()).optional(),
    occurredAt: z.coerce.date().optional(),
  })
  .strict()

const getDailyStatsInput = z
  .object({
    days: z.number().int().min(7).max(90).default(30),
  })
  .default({ days: 30 })

const getTopQuestionsInput = z
  .object({
    days: z.number().int().min(1).max(90).default(7),
  })
  .default({ days: 7 })

function startOfUtcDay(date: Date): Date {
  const result = new Date(date)

  result.setUTCHours(0, 0, 0, 0)

  return result
}

async function resolveVenueTenant(
  db: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx']['db'],
  venueId: string,
) {
  // Guest sessions have no auth context by design, so this is the one allowed
  // publicProcedure write path: we resolve tenant ownership from the venue row.
  const [venue] = await db.$queryRaw<{ id: string; tenantId: string }[]>`
    SELECT id, tenant_id AS "tenantId" FROM venues WHERE id = ${venueId} AND is_active = true LIMIT 1
  `

  return venue ?? null
}

async function syncGuestSession(
  db: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx']['db'],
  params: {
    eventType: AnalyticsEventType
    sessionId: string
    tenantId: string
    venueId: string
  },
) {
  if (params.eventType === 'session.started') {
    await db.guestSession.upsert({
      where: { id: params.sessionId },
      create: {
        id: params.sessionId,
        tenantId: params.tenantId,
        venueId: params.venueId,
      },
      update: {
        lastSeenAt: new Date(),
      },
    })

    return
  }

  if (params.eventType === 'session.ended') {
    await db.guestSession.updateMany({
      where: { id: params.sessionId, tenantId: params.tenantId },
      data: { lastSeenAt: new Date() },
    })

    return
  }

  if (params.eventType === 'message.sent') {
    await db.guestSession.upsert({
      where: { id: params.sessionId },
      create: {
        id: params.sessionId,
        tenantId: params.tenantId,
        venueId: params.venueId,
        messageCount: 1,
      },
      update: {
        lastSeenAt: new Date(),
        messageCount: {
          increment: 1,
        },
      },
    })

    return
  }

  await db.guestSession.updateMany({
    where: { id: params.sessionId, tenantId: params.tenantId },
    data: { lastSeenAt: new Date() },
  })
}

export const analyticsRouter = router({
  trackEvent: publicProcedure.input(analyticsTrackEventInput).mutation(async ({ ctx, input }) => {
    const venue = await resolveVenueTenant(ctx.db, input.venueId)

    if (!venue) {
      return { ok: false as const }
    }

    await ctx.db.analyticsEvent.create({
      data: {
        tenantId: venue.tenantId,
        venueId: input.venueId,
        sessionId: input.sessionId,
        eventType: input.eventType,
        occurredAt: input.occurredAt ?? new Date(),
        ...(input.placeId !== undefined ? { placeId: input.placeId } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      },
    })

    await syncGuestSession(ctx.db, {
      eventType: input.eventType,
      sessionId: input.sessionId,
      tenantId: venue.tenantId,
      venueId: input.venueId,
    })

    return { ok: true as const }
  }),

  getLatestDigest: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.weeklyDigest.findFirst({
      where: {
        tenantId: ctx.session.activeTenantId,
        status: 'COMPLETE',
      },
      orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        sessionCount: true,
        messageCount: true,
        insights: true,
        generatedAt: true,
        createdAt: true,
      },
    })
  }),

  listDigests: tenantProcedure.query(async ({ ctx }) => {
    return ctx.db.weeklyDigest.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
      },
      orderBy: [{ weekStart: 'desc' }, { createdAt: 'desc' }],
      take: 8,
      select: {
        id: true,
        weekStart: true,
        weekEnd: true,
        status: true,
        sessionCount: true,
        messageCount: true,
        generatedAt: true,
      },
    })
  }),

  getDigest: tenantProcedure
    .input(
      z
        .object({
          id: z.string(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const digest = await ctx.db.weeklyDigest.findFirst({
        where: {
          id: input.id,
          tenantId: ctx.session.activeTenantId,
        },
        select: {
          id: true,
          weekStart: true,
          weekEnd: true,
          status: true,
          sessionCount: true,
          messageCount: true,
          insights: true,
          generatedAt: true,
          createdAt: true,
        },
      })

      if (!digest) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Digest not found',
        })
      }

      return digest
    }),

  getDailyStats: tenantProcedure.input(getDailyStatsInput).query(async ({ ctx, input }) => {
    const startDate = startOfUtcDay(new Date())
    startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))

    return ctx.db.dailyRollup.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        date: {
          gte: startDate,
        },
      },
      orderBy: [{ date: 'asc' }, { metric: 'asc' }, { venueId: 'asc' }],
      select: {
        id: true,
        tenantId: true,
        venueId: true,
        date: true,
        metric: true,
        placeId: true,
        category: true,
        value: true,
      },
    })
  }),

  getTopQuestions: tenantProcedure.input(getTopQuestionsInput).query(async ({ ctx, input }) => {
    const startDate = new Date()
    startDate.setUTCDate(startDate.getUTCDate() - input.days)

    const events = await ctx.db.analyticsEvent.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        eventType: 'message.sent',
        occurredAt: {
          gte: startDate,
        },
      },
      orderBy: {
        occurredAt: 'desc',
      },
      take: 200,
      select: {
        metadata: true,
      },
    })

    const grouped = new Map<string, { question: string; count: number }>()

    for (const event of events) {
      if (!event.metadata || typeof event.metadata !== 'object' || Array.isArray(event.metadata)) {
        continue
      }

      const message = event.metadata.message

      if (typeof message !== 'string') {
        continue
      }

      const trimmed = message.trim()

      if (!trimmed) {
        continue
      }

      const normalized = trimmed.toLowerCase()
      const existing = grouped.get(normalized)

      if (existing) {
        existing.count += 1
        continue
      }

      grouped.set(normalized, {
        question: trimmed,
        count: 1,
      })
    }

    return Array.from(grouped.values())
      .sort((left, right) => {
        if (right.count !== left.count) {
          return right.count - left.count
        }

        return left.question.localeCompare(right.question)
      })
      .slice(0, 10)
  }),
})
