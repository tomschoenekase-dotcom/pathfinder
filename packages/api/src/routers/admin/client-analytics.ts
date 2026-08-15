import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminClientAnalyticsRouter = router({
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
            where: {
              tenantId: input.tenantId,
              experienceScope: 'PUBLIC',
              startedAt: { gte: startDate },
            },
          }),
          db.message.count({
            where: {
              tenantId: input.tenantId,
              session: { experienceScope: 'PUBLIC' },
              createdAt: { gte: startDate },
            },
          }),
          db.visitorSession.findMany({
            where: {
              tenantId: input.tenantId,
              experienceScope: 'PUBLIC',
              startedAt: { gte: startDate },
              visitorId: { not: null },
            },
            select: { visitorId: true },
            distinct: ['visitorId'],
          }),
          db.visitorSession.findMany({
            where: {
              tenantId: input.tenantId,
              experienceScope: 'PUBLIC',
              startedAt: { gte: startDate },
            },
            orderBy: { startedAt: 'desc' },
            take: 20,
            select: {
              id: true,
              startedAt: true,
              lastActiveAt: true,
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
          recentSessions: recentSessions.map((session) => ({
            ...session,
            messageCount: session.messages.filter((message) => message.role === 'user').length,
          })),
          questionClusters,
        }
      })
    }),

  getClientAiCosts: adminProcedure
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
        const endDateExclusive = new Date()
        endDateExclusive.setUTCDate(endDateExclusive.getUTCDate() + 1)
        endDateExclusive.setUTCHours(0, 0, 0, 0)

        const [tenant, rows] = await Promise.all([
          db.tenant.findUnique({
            where: { id: input.tenantId },
            select: { id: true, name: true, slug: true },
          }),
          db.aiUsageDailyRollup.findMany({
            where: {
              tenantId: input.tenantId,
              date: { gte: startDate, lt: endDateExclusive },
            },
            orderBy: [{ date: 'asc' }, { venueId: 'asc' }, { feature: 'asc' }],
            select: {
              date: true,
              venueId: true,
              feature: true,
              requestCount: true,
              successfulRequestCount: true,
              failedRequestCount: true,
              totalTokens: true,
              estimatedCostUsd: true,
              venue: { select: { name: true } },
            },
          }),
        ])

        if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })

        let totalCostUnits = 0n
        let requestCount = 0
        let successfulRequestCount = 0
        let failedRequestCount = 0
        let totalTokens = 0
        const byVenue = new Map<
          string,
          {
            venueId: string
            venueName: string
            requestCount: number
            totalTokens: number
            costUnits: bigint
            features: Map<
              string,
              { feature: string; requestCount: number; totalTokens: number; costUnits: bigint }
            >
          }
        >()
        const costs = rows.map((row) => {
          const costUnits = aiCostDecimalToUnits(row.estimatedCostUsd)
          const estimatedCostUsd = aiCostUnitsToDecimal(costUnits)
          totalCostUnits += costUnits
          requestCount += row.requestCount
          successfulRequestCount += row.successfulRequestCount
          failedRequestCount += row.failedRequestCount
          totalTokens += row.totalTokens

          const venue = byVenue.get(row.venueId) ?? {
            venueId: row.venueId,
            venueName: row.venue.name,
            requestCount: 0,
            totalTokens: 0,
            costUnits: 0n,
            features: new Map(),
          }
          venue.requestCount += row.requestCount
          venue.totalTokens += row.totalTokens
          venue.costUnits += costUnits
          const feature = venue.features.get(row.feature) ?? {
            feature: row.feature,
            requestCount: 0,
            totalTokens: 0,
            costUnits: 0n,
          }
          feature.requestCount += row.requestCount
          feature.totalTokens += row.totalTokens
          feature.costUnits += costUnits
          venue.features.set(row.feature, feature)
          byVenue.set(row.venueId, venue)

          return { ...row, estimatedCostUsd }
        })

        const breakdown = [...byVenue.values()].map(({ costUnits, features, ...venue }) => ({
          ...venue,
          estimatedCostUsd: aiCostUnitsToDecimal(costUnits),
          features: [...features.values()].map(({ costUnits: featureCostUnits, ...feature }) => ({
            ...feature,
            estimatedCostUsd: aiCostUnitsToDecimal(featureCostUnits),
          })),
        }))

        return {
          tenant,
          startDate,
          endDateExclusive,
          days: input.days,
          totals: {
            requestCount,
            successfulRequestCount,
            failedRequestCount,
            totalTokens,
            estimatedCostUsd: aiCostUnitsToDecimal(totalCostUnits),
          },
          breakdown,
          costs,
          completeness: 'estimated-lower-bound' as const,
        }
      })
    }),
})
