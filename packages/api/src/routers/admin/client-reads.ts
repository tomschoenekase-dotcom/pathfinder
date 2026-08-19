import { z } from 'zod'
import { TRPCError } from '@trpc/server'

import { db, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminClientReadsRouter = router({
  listClients: adminProcedure.query(async () => {
    return withTenantIsolationBypass(() =>
      db.tenant.findMany({
        orderBy: { createdAt: 'desc' },
        // Compatibility-only endpoint. New interfaces use searchClients;
        // keep legacy callers bounded until the procedure can be removed.
        take: 100,
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
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
      }),
    )
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
            updatedAt: true,
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

        const [
          sessions7d,
          messages7d,
          uploadRows,
          intakeRows,
          packageRows,
          openQuestions,
          latestEvalRun,
          firstSource,
          firstApprovedPackage,
          firstPreviewFeedback,
          correctionCount,
          missingKnowledgeRows,
        ] = await Promise.all([
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
          db.intakeUpload.groupBy({
            by: ['status'],
            where: { tenantId: input.tenantId, venueId: input.venueId },
            _count: { _all: true },
          }),
          db.intakeRun.groupBy({
            by: ['status'],
            where: { tenantId: input.tenantId, venueId: input.venueId },
            _count: { _all: true },
          }),
          db.venuePackage.groupBy({
            by: ['status'],
            where: { tenantId: input.tenantId, venueId: input.venueId },
            _count: { _all: true },
          }),
          db.supportRequest.count({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: { notIn: ['COMPLETED', 'CANCELLED'] },
              missingInformation: { isEmpty: false },
            },
          }),
          db.evalRun.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: { id: true, status: true, createdAt: true },
          }),
          db.intakeRun.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { createdAt: true },
          }),
          db.venuePackage.findFirst({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              status: { in: ['APPROVED', 'APPLIED'] },
              approvedAt: { not: null },
            },
            orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
            select: { approvedAt: true },
          }),
          db.supportPreviewFeedback.findFirst({
            where: { tenantId: input.tenantId, venueId: input.venueId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { createdAt: true },
          }),
          db.supportRequest.count({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              artifacts: { path: ['kind'], equals: 'INTAKE_SOURCE_CORRECTION' },
            },
          }),
          db.supportRequest.findMany({
            where: {
              tenantId: input.tenantId,
              venueId: input.venueId,
              missingInformation: { isEmpty: false },
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: 500,
            select: { missingInformation: true },
          }),
        ])

        const uploadCounts = new Map(uploadRows.map((row) => [row.status, row._count._all]))
        const intakeCounts = new Map(intakeRows.map((row) => [row.status, row._count._all]))
        const packageCounts = new Map(packageRows.map((row) => [row.status, row._count._all]))
        const latestEvalResults = latestEvalRun
          ? await db.evalResult.groupBy({
              by: ['outcome', 'passed'],
              where: {
                tenantId: input.tenantId,
                venueId: input.venueId,
                runId: latestEvalRun.id,
              },
              _count: { _all: true },
            })
          : []
        const missingKnowledgeCounts = new Map<string, number>()
        for (const row of missingKnowledgeRows)
          for (const item of row.missingInformation) {
            const normalized = item.trim().toLocaleLowerCase('en-US')
            if (normalized)
              missingKnowledgeCounts.set(
                normalized,
                (missingKnowledgeCounts.get(normalized) ?? 0) + 1,
              )
          }
        const repeatedMissingKnowledge = [...missingKnowledgeCounts.entries()]
          .filter(([, count]) => count > 1)
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .slice(0, 5)
          .map(([prompt, count]) => ({ prompt, count }))

        return {
          venue,
          places,
          engagement7d: { sessions: sessions7d, messages: messages7d },
          onboarding: {
            materials: {
              received: [...uploadCounts.values()].reduce((sum, count) => sum + count, 0),
              checking:
                (uploadCounts.get('RESERVED') ?? 0) +
                (uploadCounts.get('VERIFYING') ?? 0) +
                (uploadCounts.get('PRECHECK_PASSED') ?? 0),
              needsAttention: uploadCounts.get('REJECTED') ?? 0,
              reviewable: uploadCounts.get('AWAITING_REVIEW') ?? 0,
            },
            proposedSources: intakeCounts.get('AWAITING_REVIEW') ?? 0,
            openQuestions,
            packages: {
              draft: packageCounts.get('DRAFT') ?? 0,
              approved: packageCounts.get('APPROVED') ?? 0,
              applied: packageCounts.get('APPLIED') ?? 0,
              reverted: packageCounts.get('REVERTED') ?? 0,
            },
            qa: {
              runId: latestEvalRun?.id ?? null,
              status: latestEvalRun?.status ?? 'NOT_RUN',
              passed: latestEvalResults.reduce(
                (sum, row) =>
                  sum + (row.outcome === 'SCORED' && row.passed === true ? row._count._all : 0),
                0,
              ),
              failed: latestEvalResults.reduce(
                (sum, row) =>
                  sum + (row.outcome === 'SCORED' && row.passed === false ? row._count._all : 0),
                0,
              ),
              operationalIssues: latestEvalResults.reduce(
                (sum, row) => sum + (row.outcome === 'SCORED' ? 0 : row._count._all),
                0,
              ),
            },
            release: {
              clientCanPublish: false as const,
              released:
                venue.isActive &&
                ((packageCounts.get('APPLIED') ?? 0) > 0 || venue._count.places > 0),
            },
            metrics: {
              source: 'DURABLE_DOMAIN_RECORDS' as const,
              venueCreatedAt: venue.createdAt,
              firstSourceAt: firstSource?.createdAt ?? null,
              firstReviewedPackageAt: firstApprovedPackage?.approvedAt ?? null,
              firstPreviewFeedbackAt: firstPreviewFeedback?.createdAt ?? null,
              correctionCount,
              missingKnowledgeRequestCount: missingKnowledgeRows.length,
              repeatedMissingKnowledge,
            },
          },
        }
      })
    }),
})
