import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import type { PublicAnalyticsEventType } from '@pathfinder/analytics/events'
import { TOPIC_LABELS, type TopicKey } from '@pathfinder/analytics/topics'

import { publicTRPCError, router } from '../core'
import type { TRPCContext } from '../context'
import { checkRateLimit } from '../lib/rate-limit'
import { requireVenueReportsEnabled } from '../lib/venue-report-configuration'
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

const publicEventIdentity = {
  sessionId: z.string().uuid(),
  venueId: z.string().cuid(),
  visitorId: z.string().uuid().optional(),
} as const

const analyticsTrackEventInput = z.discriminatedUnion('eventType', [
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('session.started'),
      // Transitional compatibility for already-cached browser bundles. The server
      // deliberately discards this timestamp and owns occurredAt below.
      metadata: z
        .object({ timestamp: z.string().max(64).datetime() })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('session.ended'),
      metadata: z
        .object({
          durationSeconds: z
            .number()
            .int()
            .min(0)
            .max(7 * 24 * 60 * 60),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('place_card.viewed'),
      placeId: z.string().cuid(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('place_card.clicked'),
      placeId: z.string().cuid(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('directions.opened'),
      placeId: z.string().cuid(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('operational_update.viewed'),
      metadata: z.object({ operationalUpdateId: z.string().cuid() }).strict(),
    })
    .strict(),
  z
    .object({
      ...publicEventIdentity,
      eventType: z.literal('visitor.action.clicked'),
      metadata: z
        .object({
          actionType: z.enum([
            'NAVIGATE',
            'SHOW_ON_MAP',
            'CALL',
            'OPEN_WEBSITE',
            'BUY_TICKETS',
            'LEARN_MORE',
            'ASK_STAFF',
            'OPEN_EXHIBIT',
            'START_DIRECTIONS',
            'VIEW_ACCESSIBILITY_INFO',
          ]),
          analyticsKey: z
            .string()
            .min(1)
            .max(100)
            .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u),
          targetKind: z.enum(['URL', 'PHONE', 'LOCATION_ID', 'PLACE_ID', 'STAFF']),
          targetId: z.string().min(1).max(191).optional(),
        })
        .strict(),
    })
    .strict(),
])

const PUBLIC_ANALYTICS_SESSION_LIMIT_PER_MINUTE = 120
const PUBLIC_ANALYTICS_VENUE_LIMIT_PER_MINUTE = 3_000
const PUBLIC_ANALYTICS_GLOBAL_LIMIT_PER_MINUTE = 10_000

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

const getPlaceInterestOverviewInput = z
  .object({
    days: z.number().int().min(1).max(90).default(30),
    limitPerVenue: z.number().int().min(1).max(25).default(10),
  })
  .default({ days: 30, limitPerVenue: 10 })

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
    eventType: PublicAnalyticsEventType
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
    const session = await db.visitorSession.upsert({
      where: {
        venueId_anonymousToken: {
          venueId: params.venueId,
          anonymousToken: params.sessionId,
        },
        tenantId: params.tenantId,
      },
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
      select: { id: true },
    })
    return session.id
  }

  const session = await db.visitorSession.findFirst({
    where: {
      anonymousToken: params.sessionId,
      tenantId: params.tenantId,
      venueId: params.venueId,
    },
    select: { id: true },
  })
  if (!session) return null

  await db.visitorSession.updateMany({
    where: {
      id: session.id,
      anonymousToken: params.sessionId,
      tenantId: params.tenantId,
      venueId: params.venueId,
    },
    data: { lastActiveAt: new Date() },
  })
  return session.id
}

export const analyticsRouter = router({
  trackEvent: publicProcedure.input(analyticsTrackEventInput).mutation(async ({ ctx, input }) => {
    const globallyAllowed = await checkRateLimit(
      'ratelimit:analytics:ingress:global',
      PUBLIC_ANALYTICS_GLOBAL_LIMIT_PER_MINUTE,
      60,
    )
    if (!globallyAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many analytics events. Please try again later.',
      })
    }

    const venue = await resolveVenueTenant(ctx.db, input.venueId)

    if (!venue) {
      return { ok: false as const }
    }

    const venueAllowed = await checkRateLimit(
      `ratelimit:analytics:venue:${venue.id}`,
      PUBLIC_ANALYTICS_VENUE_LIMIT_PER_MINUTE,
      60,
    )
    if (!venueAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many analytics events. Please try again later.',
      })
    }

    const sessionAllowed = await checkRateLimit(
      `ratelimit:analytics:session:${venue.id}:${input.sessionId}`,
      PUBLIC_ANALYTICS_SESSION_LIMIT_PER_MINUTE,
      60,
    )
    if (!sessionAllowed) {
      throw publicTRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Too many analytics events. Please try again later.',
      })
    }

    const occurredAt = new Date()
    if ('placeId' in input) {
      const place = await ctx.db.place.findFirst({
        where: {
          id: input.placeId,
          tenantId: venue.tenantId,
          venueId: venue.id,
          isActive: true,
        },
        select: { id: true },
      })
      if (!place) return { ok: false as const }
    }

    if (input.eventType === 'operational_update.viewed') {
      const update = await ctx.db.operationalUpdate.findFirst({
        where: {
          id: input.metadata.operationalUpdateId,
          tenantId: venue.tenantId,
          venueId: venue.id,
          status: 'PUBLISHED',
          isActive: true,
          startsAt: { lte: occurredAt },
          expiresAt: { gt: occurredAt },
        },
        select: { id: true },
      })
      if (!update) return { ok: false as const }
    }

    const metadata =
      input.eventType === 'session.ended' ||
      input.eventType === 'operational_update.viewed' ||
      input.eventType === 'visitor.action.clicked'
        ? input.metadata
        : undefined

    const internalSessionId = await syncVisitorSession(ctx.db, {
      eventType: input.eventType,
      sessionId: input.sessionId,
      tenantId: venue.tenantId,
      venueId: venue.id,
      ...(input.visitorId !== undefined ? { visitorId: input.visitorId } : {}),
    })
    if (!internalSessionId) return { ok: false as const }

    await ctx.db.analyticsEvent.create({
      data: {
        tenantId: venue.tenantId,
        venueId: venue.id,
        sessionId: internalSessionId,
        eventType: input.eventType,
        occurredAt,
        ...('placeId' in input ? { placeId: input.placeId } : {}),
        ...(metadata !== undefined ? { metadata } : {}),
      },
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

  getWeeklyReportAvailability: tenantProcedure.query(async ({ ctx }) => {
    const configurations = await ctx.db.venueReportConfiguration.findMany({
      where: {
        tenantId: ctx.session.activeTenantId,
        enabled: true,
        venue: { isActive: true },
      },
      orderBy: { venueId: 'asc' },
      select: { venueId: true },
    })
    return { enabledVenueIds: configurations.map((configuration) => configuration.venueId) }
  }),

  listPublishedWeeklyReports: tenantProcedure
    .input(
      z
        .object({
          venueId: z.string(),
          limit: z.number().int().min(1).max(25).default(10),
          cursor: z
            .object({ weekStart: z.coerce.date(), id: z.string().min(1).max(191) })
            .strict()
            .optional(),
        })
        .strict(),
    )
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId, isActive: true },
        select: { id: true },
      })

      if (!venue) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      }

      await requireVenueReportsEnabled(ctx.db, ctx.session.activeTenantId, input.venueId)

      const reports = await ctx.db.weeklyReport.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          status: 'PUBLISHED',
          ...(input.cursor
            ? {
                OR: [
                  { weekStart: { lt: input.cursor.weekStart } },
                  { weekStart: input.cursor.weekStart, id: { lt: input.cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ weekStart: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          title: true,
          weekStart: true,
          weekEnd: true,
          publishedAt: true,
        },
      })
      const hasMore = reports.length > input.limit
      const items = hasMore ? reports.slice(0, input.limit) : reports
      const last = items.at(-1)
      return {
        items,
        nextCursor: hasMore && last ? { weekStart: last.weekStart, id: last.id } : null,
      }
    }),

  getPublishedWeeklyReport: tenantProcedure
    .input(z.object({ venueId: z.string(), reportId: z.string() }).strict())
    .query(async ({ ctx, input }) => {
      const venue = await ctx.db.venue.findFirst({
        where: { id: input.venueId, tenantId: ctx.session.activeTenantId, isActive: true },
        select: { id: true },
      })
      if (!venue) throw new TRPCError({ code: 'NOT_FOUND', message: 'Venue not found' })
      await requireVenueReportsEnabled(ctx.db, ctx.session.activeTenantId, input.venueId)

      const report = await ctx.db.weeklyReport.findFirst({
        where: {
          id: input.reportId,
          tenantId: ctx.session.activeTenantId,
          venueId: input.venueId,
          status: 'PUBLISHED',
        },
        select: {
          id: true,
          title: true,
          weekStart: true,
          weekEnd: true,
          content: true,
          publishedAt: true,
        },
      })
      if (!report) throw new TRPCError({ code: 'NOT_FOUND', message: 'Report not found' })
      return report
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
   * Unique visitor, total session, and conversation-depth stats over the window,
   * derived from the persistent VisitorSession table.
   */
  getVisitorStats: tenantProcedure.input(getWindowInput).query(async ({ ctx, input }) => {
    const startDate = startOfUtcDay(new Date())
    startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))

    const [identifiedSessions, totalSessions, totalMessages] = await Promise.all([
      ctx.db.visitorSession.findMany({
        where: {
          tenantId: ctx.session.activeTenantId,
          experienceScope: 'PUBLIC',
          visitorId: { not: null },
          startedAt: { gte: startDate },
        },
        select: { visitorId: true, startedAt: true },
      }),
      ctx.db.visitorSession.count({
        where: {
          tenantId: ctx.session.activeTenantId,
          experienceScope: 'PUBLIC',
          startedAt: { gte: startDate },
        },
      }),
      // Counted directly from Message rows rather than VisitorSession.messageCount,
      // which is only ever incremented by the trackEvent('message.sent') path that
      // the guest chat UI never calls — it stayed 0 for every real session.
      ctx.db.message.count({
        where: {
          tenantId: ctx.session.activeTenantId,
          session: { experienceScope: 'PUBLIC' },
          createdAt: { gte: startDate },
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

    return {
      uniqueVisitors: daysByVisitor.size,
      totalMessages,
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
   * Top 3 guest-question themes, refreshed weekly by the analytics-enrichment
   * job. Replaces the old raw "top questions" / "topics" lists with a short
   * title + explanation per theme. Merges across venues, most recently
   * generated venue's themes win when a tenant has more than one.
   */
  getWeeklyThemes: tenantProcedure.query(async ({ ctx }) => {
    const latest = await ctx.db.venueWeeklyTheme.findFirst({
      where: { tenantId: ctx.session.activeTenantId },
      orderBy: [{ weekStart: 'desc' }, { generatedAt: 'desc' }],
      select: { weekStart: true, weekEnd: true, generatedAt: true, themes: true },
    })

    if (!latest) {
      return {
        weekStart: null,
        weekEnd: null,
        themes: [] as { title: string; explanation: string }[],
      }
    }

    const themes = Array.isArray(latest.themes)
      ? latest.themes.filter(
          (theme): theme is { title: string; explanation: string } =>
            typeof theme === 'object' &&
            theme !== null &&
            typeof (theme as { title?: unknown }).title === 'string' &&
            typeof (theme as { explanation?: unknown }).explanation === 'string',
        )
      : []

    return { weekStart: latest.weekStart, weekEnd: latest.weekEnd, themes }
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

/** Server-only batched primitive. It is deliberately not mounted on the client-facing router. */
export async function loadPlaceInterestOverview(
  db: TRPCContext['db'],
  tenantId: string,
  rawInput?: z.input<typeof getPlaceInterestOverviewInput>,
) {
  const input = getPlaceInterestOverviewInput.parse(rawInput)
  const startDate = startOfUtcDay(new Date())
  startDate.setUTCDate(startDate.getUTCDate() - (input.days - 1))
  const metrics = Object.keys(PLACE_INTEREST_WEIGHTS) as PlaceInterestMetric[]
  const rows = await db.dailyRollup.groupBy({
    by: ['venueId', 'placeId', 'metric'],
    where: { tenantId, metric: { in: metrics }, placeId: { not: null }, date: { gte: startDate } },
    _sum: { value: true },
  })
  const placeIds = Array.from(new Set(rows.flatMap((row) => (row.placeId ? [row.placeId] : []))))
  const places = placeIds.length
    ? await db.place.findMany({
        where: { tenantId, id: { in: placeIds } },
        select: { id: true, name: true },
      })
    : []
  const nameById = new Map(places.map((place) => [place.id, place.name]))
  const byVenue = new Map<string, Map<string, Record<PlaceInterestMetric, number>>>()
  for (const row of rows) {
    if (!row.placeId || !(row.metric in PLACE_INTEREST_WEIGHTS)) continue
    const venue = byVenue.get(row.venueId) ?? new Map()
    const totals =
      venue.get(row.placeId) ??
      ({
        place_mentions: 0,
        place_card_views: 0,
        place_card_clicks: 0,
        place_directions: 0,
      } satisfies Record<PlaceInterestMetric, number>)
    totals[row.metric as PlaceInterestMetric] += row._sum.value ?? 0
    venue.set(row.placeId, totals)
    byVenue.set(row.venueId, venue)
  }
  return Array.from(byVenue.entries()).map(([venueId, venue]) => ({
    venueId,
    places: Array.from(venue.entries())
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
      .slice(0, input.limitPerVenue),
  }))
}

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
