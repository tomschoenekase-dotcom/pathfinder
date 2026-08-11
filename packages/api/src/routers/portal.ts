import { resolveClientPortalLifecycle } from '@pathfinder/contracts/client-portal-lifecycle'

import { router } from '../core'
import { tenantProcedure } from '../trpc'

type CountRow = { venueId: string; status: string; _count: { _all: number } }

function countsByVenue(rows: CountRow[]): Map<string, Map<string, number>> {
  const result = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const venue = result.get(row.venueId) ?? new Map<string, number>()
    venue.set(row.status, row._count._all)
    result.set(row.venueId, venue)
  }
  return result
}

function total(statuses: Map<string, number> | undefined, names: readonly string[]): number {
  return names.reduce((sum, status) => sum + (statuses?.get(status) ?? 0), 0)
}

export const portalRouter = router({
  getVenueLifecycles: tenantProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.session.activeTenantId
    const [venues, intakeRows, mediaRows, packageRows, previouslyActive, offboardingTargets] =
      await Promise.all([
        ctx.db.venue.findMany({
          where: { tenantId },
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            name: true,
            isActive: true,
            _count: {
              select: {
                places: { where: { isActive: true } },
                knowledgeEntries: { where: { isEnabled: true } },
              },
            },
          },
        }),
        ctx.db.intakeRun.groupBy({
          by: ['venueId', 'status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        ctx.db.mediaIngestionProject.groupBy({
          by: ['venueId', 'status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        ctx.db.venuePackage.groupBy({
          by: ['venueId', 'status'],
          where: { tenantId },
          _count: { _all: true },
        }),
        ctx.db.contentVersion.findMany({
          where: {
            tenantId,
            entityType: 'VENUE',
            afterState: { path: ['isActive'], equals: true },
          },
          select: { venueId: true },
          distinct: ['venueId'],
        }),
        ctx.db.offboardingVenueTarget.findMany({
          where: {
            tenantId,
            plan: { status: { notIn: ['COMPLETED', 'CANCELLED'] } },
          },
          select: { venueId: true },
          distinct: ['venueId'],
        }),
      ])

    const intake = countsByVenue(intakeRows)
    const media = countsByVenue(mediaRows)
    const packages = countsByVenue(packageRows)
    const activeHistory = new Set(previouslyActive.map(({ venueId }) => venueId))
    const offboarding = new Set(offboardingTargets.map(({ venueId }) => venueId))

    return venues.map((venue) => {
      const mediaStatuses = media.get(venue.id)
      const packageStatuses = packages.get(venue.id)
      const packageCounts = {
        draft: packageStatuses?.get('DRAFT') ?? 0,
        approved: packageStatuses?.get('APPROVED') ?? 0,
        applied: packageStatuses?.get('APPLIED') ?? 0,
        reverted: packageStatuses?.get('REVERTED') ?? 0,
      }
      const publicContentCount = venue._count.places + venue._count.knowledgeEntries
      const lifecycle = resolveClientPortalLifecycle({
        isActive: venue.isActive,
        publicContentCount,
        wasLive:
          activeHistory.has(venue.id) && (publicContentCount > 0 || packageCounts.applied > 0),
        collectingSourceCount: total(mediaStatuses, ['DRAFT', 'UPLOADING', 'NEEDS_INPUT']),
        processingSourceCount: total(mediaStatuses, [
          'QUEUED',
          'INVENTORYING',
          'ANALYZING',
          'SYNTHESIZING',
        ]),
        reviewSourceCount: total(mediaStatuses, ['READY_FOR_REVIEW', 'COMPLETE']),
        intakeProposalCount: total(intake.get(venue.id), ['AWAITING_REVIEW']),
        packageCounts,
        hasActiveOffboarding: offboarding.has(venue.id),
      })
      return { venueId: venue.id, venueName: venue.name, lifecycle }
    })
  }),
})
