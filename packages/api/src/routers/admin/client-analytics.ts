import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { aiCostDecimalToUnits, aiCostUnitsToDecimal } from '@pathfinder/ai'
import { FirstWeekAccountReviewMetrics } from '@pathfinder/contracts'
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
          firstWeekReviews,
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
              venueId: true,
              startedAt: true,
              lastActiveAt: true,
              visitorId: true,
              venue: { select: { name: true } },
              _count: {
                select: {
                  messages: { where: { role: 'user' } },
                },
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
          db.firstWeekAccountReview.findMany({
            where: { tenantId: input.tenantId },
            orderBy: [{ dueAt: 'desc' }, { id: 'desc' }],
            take: 30,
            select: {
              id: true,
              venueId: true,
              milestone: true,
              releaseAt: true,
              dueAt: true,
              metrics: true,
              disposition: true,
              draftSubject: true,
              draftBody: true,
              draftReason: true,
              createdAt: true,
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
          recentSessions: recentSessions.map(({ _count, ...session }) => ({
            ...session,
            messageCount: _count.messages,
          })),
          questionClusters,
          firstWeekReviews: firstWeekReviews.map((review) => ({
            ...review,
            metrics: FirstWeekAccountReviewMetrics.parse(review.metrics),
            communicationAuthority: 'draft-only' as const,
          })),
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
              observedUsageRequestCount: true,
              unknownUsageRequestCount: true,
              notDispatchedRequestCount: true,
              legacyUnclassifiedRequestCount: true,
              totalTokens: true,
              estimatedCostUsd: true,
              observedTotalTokens: true,
              observedEstimatedCostUsd: true,
              venue: { select: { name: true } },
            },
          }),
        ])

        if (!tenant) throw new TRPCError({ code: 'NOT_FOUND', message: 'Client not found' })

        let totalCostUnits = 0n
        let observedCostUnits = 0n
        let requestCount = 0
        let successfulRequestCount = 0
        let failedRequestCount = 0
        let totalTokens = 0
        let observedUsageRequestCount = 0
        let unknownUsageRequestCount = 0
        let notDispatchedRequestCount = 0
        let legacyUnclassifiedRequestCount = 0
        const byVenue = new Map<
          string,
          {
            venueId: string | null
            venueName: string
            requestCount: number
            totalTokens: number
            costUnits: bigint
            observedCostUnits: bigint
            observedRequestCount: number
            unknownRequestCount: number
            notDispatchedRequestCount: number
            legacyUnclassifiedRequestCount: number
            features: Map<
              string,
              {
                feature: string
                requestCount: number
                totalTokens: number
                costUnits: bigint
                observedCostUnits: bigint
                observedRequestCount: number
                unknownRequestCount: number
                notDispatchedRequestCount: number
                legacyUnclassifiedRequestCount: number
              }
            >
          }
        >()
        const costs = rows.map((row) => {
          const costUnits = aiCostDecimalToUnits(row.estimatedCostUsd)
          const estimatedCostUsd = aiCostUnitsToDecimal(costUnits)
          totalCostUnits += costUnits
          observedCostUnits += aiCostDecimalToUnits(row.observedEstimatedCostUsd)
          requestCount += row.requestCount
          successfulRequestCount += row.successfulRequestCount
          failedRequestCount += row.failedRequestCount
          totalTokens += row.totalTokens
          observedUsageRequestCount += row.observedUsageRequestCount
          unknownUsageRequestCount += row.unknownUsageRequestCount
          notDispatchedRequestCount += row.notDispatchedRequestCount
          legacyUnclassifiedRequestCount += row.legacyUnclassifiedRequestCount

          const venueKey = row.venueId === null ? 'tenant-wide' : `venue:${row.venueId}`
          const venue = byVenue.get(venueKey) ?? {
            venueId: row.venueId,
            venueName: row.venue?.name ?? 'Tenant-wide',
            requestCount: 0,
            totalTokens: 0,
            costUnits: 0n,
            observedCostUnits: 0n,
            observedRequestCount: 0,
            unknownRequestCount: 0,
            notDispatchedRequestCount: 0,
            legacyUnclassifiedRequestCount: 0,
            features: new Map(),
          }
          venue.requestCount += row.requestCount
          venue.totalTokens += row.totalTokens
          venue.costUnits += costUnits
          venue.observedCostUnits += aiCostDecimalToUnits(row.observedEstimatedCostUsd)
          venue.observedRequestCount += row.observedUsageRequestCount
          venue.unknownRequestCount += row.unknownUsageRequestCount
          venue.notDispatchedRequestCount += row.notDispatchedRequestCount
          venue.legacyUnclassifiedRequestCount += row.legacyUnclassifiedRequestCount
          const feature = venue.features.get(row.feature) ?? {
            feature: row.feature,
            requestCount: 0,
            totalTokens: 0,
            costUnits: 0n,
            observedCostUnits: 0n,
            observedRequestCount: 0,
            unknownRequestCount: 0,
            notDispatchedRequestCount: 0,
            legacyUnclassifiedRequestCount: 0,
          }
          feature.requestCount += row.requestCount
          feature.totalTokens += row.totalTokens
          feature.costUnits += costUnits
          feature.observedCostUnits += aiCostDecimalToUnits(row.observedEstimatedCostUsd)
          feature.observedRequestCount += row.observedUsageRequestCount
          feature.unknownRequestCount += row.unknownUsageRequestCount
          feature.notDispatchedRequestCount += row.notDispatchedRequestCount
          feature.legacyUnclassifiedRequestCount += row.legacyUnclassifiedRequestCount
          venue.features.set(row.feature, feature)
          byVenue.set(venueKey, venue)

          const classified =
            row.observedUsageRequestCount +
            row.unknownUsageRequestCount +
            row.notDispatchedRequestCount +
            row.legacyUnclassifiedRequestCount
          return {
            ...row,
            estimatedCostUsd,
            usageCoverageStatus:
              row.unknownUsageRequestCount === 0 &&
              row.legacyUnclassifiedRequestCount === 0 &&
              classified === row.requestCount
                ? ('COMPLETE_RECORDED_USAGE' as const)
                : ('PARTIAL_RECORDED_USAGE' as const),
          }
        })

        const coverageStatus = (requests: number, unknown: number, legacy: number) =>
          requests === 0
            ? ('NO_RECORDED_USAGE' as const)
            : unknown === 0 && legacy === 0
              ? ('COMPLETE_RECORDED_USAGE' as const)
              : ('PARTIAL_RECORDED_USAGE' as const)
        const breakdown = [...byVenue.values()].map(
          ({ costUnits, observedCostUnits, features, ...venue }) => ({
            ...venue,
            estimatedCostUsd: aiCostUnitsToDecimal(costUnits),
            observedEstimatedCostUsd: aiCostUnitsToDecimal(observedCostUnits),
            usageCoverageStatus: coverageStatus(
              venue.requestCount,
              venue.unknownRequestCount,
              venue.legacyUnclassifiedRequestCount,
            ),
            features: [...features.values()].map(
              ({
                costUnits: featureCostUnits,
                observedCostUnits: featureObservedCostUnits,
                ...feature
              }) => ({
                ...feature,
                estimatedCostUsd: aiCostUnitsToDecimal(featureCostUnits),
                observedEstimatedCostUsd: aiCostUnitsToDecimal(featureObservedCostUnits),
                usageCoverageStatus: coverageStatus(
                  feature.requestCount,
                  feature.unknownRequestCount,
                  feature.legacyUnclassifiedRequestCount,
                ),
              }),
            ),
          }),
        )

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
            usageCoverage: {
              observedRequestCount: observedUsageRequestCount,
              unknownRequestCount: unknownUsageRequestCount,
              notDispatchedRequestCount,
              legacyUnclassifiedRequestCount,
              status:
                requestCount === 0
                  ? ('NO_RECORDED_USAGE' as const)
                  : unknownUsageRequestCount === 0 &&
                      legacyUnclassifiedRequestCount === 0 &&
                      observedUsageRequestCount + notDispatchedRequestCount === requestCount
                    ? ('COMPLETE_RECORDED_USAGE' as const)
                    : ('PARTIAL_RECORDED_USAGE' as const),
            },
            estimatedCostUsd: aiCostUnitsToDecimal(totalCostUnits),
            observedEstimatedCostUsd: aiCostUnitsToDecimal(observedCostUnits),
          },
          breakdown,
          costs,
          completeness: 'estimated-lower-bound' as const,
        }
      })
    }),
})
