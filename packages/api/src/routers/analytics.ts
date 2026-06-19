import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { ANALYTICS_EVENT_TYPES, type AnalyticsEventType } from '@pathfinder/analytics/events'
import { TOPIC_LABELS, type TopicKey } from '@pathfinder/analytics'

import { router } from '../core'
import { publicProcedure, tenantProcedure } from '../trpc'

// Place-interest weighting (decision A1). Derived from existing signals, NOT GPS
// dwell time. Kept in one constant so the weights are easy to tune on real data.
const PLACE_INTEREST_WEIGHTS = {
  place_mentions: 1,
  place_card_views: 1,
  place_card_clicks: 2,
  place_directions: 3,
} as const

type PlaceInterestMetric = keyof typeof PLACE_INTEREST_WEIGHTS

const analyticsTrackEventInput = z
  .object({
    sessionId: z.string().uuid(),
    venueId: z.string().cuid(),
    visitorId: z.string().uuid().optional(),
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

const getWindowInput = z
  .object({
    days: z.number().int().min(1).max(90).default(30),
  })
  .default({ days: 30 })

const getPlaceInterestInput = z
  .object({
    venueId: z.string().cuid(),
    days: z.number().int().min(1).max(90).default(30),
  })
  .strict()

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

async function syncVisitorSession(
  db: Parameters<Parameters<typeof publicProcedure.mutation>[0]>[0]['ctx']['db'],
  params: {
    eventType: AnalyticsEventType
    sessionId: string
    tenantId: string
    venueId: string
    visitorId?: string
  },
) {
  // Set visitorId when provided so unique/returning visitor counts work even if
  // the very first signal for a session arrives via analytics rather than chat.
  const visitorIdData = params.visitorId !== undefined ? { visitorId: params.visitorId } : {}

  if (params.eventType === 'session.started') {
    await db.visitorSession.upsert({
      where: { anonymousToken: params.sessionId },
      create: {
        tenantId: params.tenantId,
        venueId: params.venueId,
        anonymousToken: params.sessionId,
        ...visitorIdData,
      },
      update: {
        lastActiveAt: new Date(),
        ...visitorIdData,
      },
    })

    return
  }

  if (params.eventType === 'session.ended') {
    await db.visitorSession.updateMany({
      where: { anonymousToken: params.sessionId, tenantId: params.tenantId },
      data: { lastActiveAt: new Date() },
    })

    return
  }

  if (params.eventType === 'message.sent') {
    await db.visitorSession.upsert({
      where: { anonymousToken: params.sessionId },
      create: {
        tenantId: params.tenantId,
        venueId: params.venueId,
        anonymousToken: params.sessionId,
        messageCount: 1,
        ...visitorIdData,
      },
      update: {
        lastActiveAt: new Date(),
        messageCount: {
          increment: 1,
        },
        ...visitorIdData,
      },
    })

    return
  }

  await db.visitorSession.updateMany({
    where: { anonymousToken: params.sessionId, tenantId: params.tenantId },
    data: { lastActiveAt: new Date() },
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

    await syncVisitorSession(ctx.db, {
      eventType: input.eventType,
      sessionId: input.sessionId,
      tenantId: venue.tenantId,
      venueId: input.venueId,
      ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
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

  /**
   * Top questions now read pre-computed QuestionCluster rows (kind='top_question'),
   * so near-duplicate phrasings collapse into one entry. Clusters are per-venue;
   * we merge identical canonical phrasings across the tenant's venues. Shape kept
   * compatible with the previous exact-match implementation.
   */
  getTopQuestions: tenantProcedure.input(getTopQuestionsInput).query(async ({ ctx }) => {
    const clusters = await ctx.db.questionCluster.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        kind: 'top_question',
      },
      orderBy: { count: 'desc' },
      select: { canonicalText: true, count: true },
    })

    return mergeClusters(clusters).map(({ canonicalText, count }) => ({
      question: canonicalText,
      count,
    }))
  }),

  /**
   * Content gaps — questions the venue data could not confidently answer. THE
   * headline operator value of the analytics rework. Reads QuestionCluster rows
   * with kind='content_gap', merged across venues.
   */
  getContentGaps: tenantProcedure.input(getWindowInput).query(async ({ ctx }) => {
    const clusters = await ctx.db.questionCluster.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        kind: 'content_gap',
      },
      orderBy: { count: 'desc' },
      select: { canonicalText: true, count: true, examples: true },
    })

    return mergeClusters(clusters).map(({ canonicalText, count, examples }) => ({
      question: canonicalText,
      count,
      examples,
    }))
  }),

  /**
   * Unique + returning visitor counts over the window, derived from the persistent
   * VisitorSession.visitorId. Returning = a visitorId seen on >= 2 distinct UTC days.
   */
  getVisitorStats: tenantProcedure.input(getWindowInput).query(async ({ ctx, input }) => {
    const startDate = startOfUtcDay(new Date())
    startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))

    const [identifiedSessions, totalSessions] = await Promise.all([
      ctx.db.visitorSession.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          visitorId: { not: null },
          startedAt: { gte: startDate },
        },
        select: { visitorId: true, startedAt: true },
      }),
      ctx.db.visitorSession.count({
        where: {
          tenantId: ctx.session.activeTenantId,
          startedAt: { gte: startDate },
        },
      }),
    ])

    const daysByVisitor = new Map<string, Set<string>>()
    for (const session of identifiedSessions) {
      if (!session.visitorId) continue
      const day = session.startedAt.toISOString().slice(0, 10)
      const seen = daysByVisitor.get(session.visitorId) ?? new Set<string>()
      seen.add(day)
      daysByVisitor.set(session.visitorId, seen)
    }

    let returningVisitors = 0
    for (const days of daysByVisitor.values()) {
      if (days.size >= 2) returningVisitors += 1
    }

    return {
      uniqueVisitors: daysByVisitor.size,
      returningVisitors,
      totalSessions,
    }
  }),

  /**
   * Top topics over the window, summed from DailyRollup metric='topic' rows
   * (category = topic key). Labels come from the shared taxonomy.
   */
  getTopTopics: tenantProcedure.input(getWindowInput).query(async ({ ctx, input }) => {
    const startDate = startOfUtcDay(new Date())
    startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))

    const rows = await ctx.db.dailyRollup.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        metric: 'topic',
        date: { gte: startDate },
      },
      select: { category: true, value: true },
    })

    const counts = new Map<string, number>()
    for (const row of rows) {
      if (!row.category) continue
      counts.set(row.category, (counts.get(row.category) ?? 0) + row.value)
    }

    return Array.from(counts.entries())
      .map(([topic, count]) => ({
        topic,
        label: TOPIC_LABELS[topic as TopicKey] ?? topic,
        count,
      }))
      .sort((left, right) => right.count - left.count)
  }),

  /**
   * Place-interest ranking for a venue — a weighted sum of mentions, card views,
   * card clicks, and directions opened (decision A1). All from DailyRollup metrics;
   * no live OLTP aggregation.
   */
  getPlaceInterest: tenantProcedure.input(getPlaceInterestInput).query(async ({ ctx, input }) => {
    const startDate = startOfUtcDay(new Date())
    startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))

    const metrics = Object.keys(PLACE_INTEREST_WEIGHTS) as PlaceInterestMetric[]

    const [rows, places] = await Promise.all([
      ctx.db.dailyRollup.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          metric: { in: metrics },
          placeId: { not: null },
          date: { gte: startDate },
        },
        select: { placeId: true, metric: true, value: true },
      }),
      ctx.db.place.findMany({
        where: { tenantId: ctx.session.activeTenantId, venueId: input.venueId },
        select: { id: true, name: true },
      }),
    ])

    const nameById = new Map(places.map((place) => [place.id, place.name]))
    const byPlace = new Map<string, Record<PlaceInterestMetric, number>>()

    for (const row of rows) {
      if (!row.placeId) continue
      const metric = row.metric as PlaceInterestMetric
      if (!(metric in PLACE_INTEREST_WEIGHTS)) continue
      const entry =
        byPlace.get(row.placeId) ??
        ({
          place_mentions: 0,
          place_card_views: 0,
          place_card_clicks: 0,
          place_directions: 0,
        } satisfies Record<PlaceInterestMetric, number>)
      entry[metric] += row.value
      byPlace.set(row.placeId, entry)
    }

    return Array.from(byPlace.entries())
      .map(([placeId, totals]) => ({
        placeId,
        name: nameById.get(placeId) ?? 'Unknown place',
        mentions: totals.place_mentions,
        views: totals.place_card_views,
        clicks: totals.place_card_clicks,
        directions: totals.place_directions,
        score: metrics.reduce(
          (sum, metric) => sum + totals[metric] * PLACE_INTEREST_WEIGHTS[metric],
          0,
        ),
      }))
      .filter((place) => place.score > 0)
      .sort((left, right) => right.score - left.score)
  }),
})

/**
 * Merges question clusters that share an identical canonical phrasing (clusters
 * are computed per-venue, so the same question can appear under multiple venues),
 * summing counts and concatenating a few examples. Returns top 10 by count.
 */
function mergeClusters<T extends { canonicalText: string; count: number; examples?: unknown }>(
  clusters: T[],
): Array<{ canonicalText: string; count: number; examples: string[] }> {
  const merged = new Map<string, { canonicalText: string; count: number; examples: string[] }>()

  for (const cluster of clusters) {
    const key = cluster.canonicalText.toLowerCase()
    const examples = Array.isArray(cluster.examples)
      ? cluster.examples.filter((value): value is string => typeof value === 'string')
      : []
    const existing = merged.get(key)

    if (existing) {
      existing.count += cluster.count
      for (const example of examples) {
        if (existing.examples.length < 5 && !existing.examples.includes(example)) {
          existing.examples.push(example)
        }
      }
    } else {
      merged.set(key, {
        canonicalText: cluster.canonicalText,
        count: cluster.count,
        examples: examples.slice(0, 5),
      })
    }
  }

  return Array.from(merged.values())
    .sort((left, right) => right.count - left.count)
    .slice(0, 10)
}
