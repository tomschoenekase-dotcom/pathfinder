import type { BillingAccountStatus, OffboardingPlanStatus, TenantStatus } from '@prisma/client'

import { buildCustomerStatePreservationContext } from '@pathfinder/contracts/customer-state-preservation'

type CustomerStatePreservationReader = {
  tenant: {
    findFirst: (args: unknown) => Promise<{
      id: string
      status: TenantStatus
      billingAccount: { status: BillingAccountStatus } | null
    } | null>
  }
  venue: {
    findMany: (args: unknown) => Promise<
      Array<{
        id: string
        name: string
        isActive: boolean
        venueBotConfiguration: { id: string } | null
        _count: {
          places: number
          knowledgeEntries: number
          venuePackageManifestArtifacts: number
        }
      }>
    >
  }
  venuePackage: {
    groupBy: (
      args: unknown,
    ) => Promise<Array<{ venueId: string; status: string; _count: { _all: number } }>>
  }
  offboardingPlan: {
    findMany: (args: unknown) => Promise<
      Array<{
        id: string
        status: OffboardingPlanStatus
        updatedAt: Date
        venueTargets: Array<{
          venueId: string
          revocationEvidence: Array<{ outcome: 'COMPLETE' | 'FAILED' | 'SKIPPED' }>
          exportArtifacts: Array<{ id: string }>
        }>
      }>
    >
  }
}

export async function loadCustomerStatePreservation(
  rawDb: unknown,
  tenantId: string,
  venueScope?: readonly string[],
) {
  // Both the tenant-isolated Prisma extension and the plain Prisma client expose
  // these exact read delegates, but Prisma's generated generic signatures are
  // nominally incompatible. Normalize them once at this read-only adapter edge.
  const db = rawDb as CustomerStatePreservationReader
  const tenant = await db.tenant.findFirst({
    where: { id: tenantId },
    select: {
      id: true,
      status: true,
      billingAccount: { select: { status: true } },
    },
  })
  if (!tenant) return null

  const venues = await db.venue.findMany({
    where: {
      tenantId,
      ...(venueScope ? { id: { in: [...venueScope] } } : {}),
    },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      name: true,
      isActive: true,
      venueBotConfiguration: { select: { id: true } },
      _count: {
        select: {
          places: true,
          knowledgeEntries: true,
          venuePackageManifestArtifacts: true,
        },
      },
    },
  })
  const venueIds = venues.map((venue) => venue.id)
  const [packageGroups, planRows] = await Promise.all([
    venueIds.length
      ? db.venuePackage.groupBy({
          by: ['venueId', 'status'],
          where: { tenantId, venueId: { in: venueIds } },
          _count: { _all: true },
        })
      : Promise.resolve([]),
    venueIds.length
      ? db.offboardingPlan.findMany({
          where: {
            tenantId,
            status: { not: 'CANCELLED' },
            venueTargets: { some: { venueId: { in: venueIds } } },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 101,
          select: {
            id: true,
            status: true,
            updatedAt: true,
            venueTargets: {
              where: { venueId: { in: venueIds } },
              select: {
                venueId: true,
                revocationEvidence: { select: { outcome: true } },
                exportArtifacts: { select: { id: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
  ])
  const evidenceBounded = planRows.length > 100
  const latestPlanByVenue = new Map<
    string,
    {
      id: string
      status: (typeof planRows)[number]['status']
      updatedAt: Date
      revocationEvidenceCount: number
      completedRevocationCount: number
      exportArtifactCount: number
    }
  >()
  for (const plan of planRows.slice(0, 100)) {
    for (const target of plan.venueTargets) {
      if (latestPlanByVenue.has(target.venueId)) continue
      latestPlanByVenue.set(target.venueId, {
        id: plan.id,
        status: plan.status,
        updatedAt: plan.updatedAt,
        revocationEvidenceCount: target.revocationEvidence.length,
        completedRevocationCount: target.revocationEvidence.filter(
          (evidence) => evidence.outcome === 'COMPLETE',
        ).length,
        exportArtifactCount: target.exportArtifacts.length,
      })
    }
  }
  const packageCountByVenue = new Map<string, number>()
  for (const group of packageGroups) {
    packageCountByVenue.set(
      group.venueId,
      (packageCountByVenue.get(group.venueId) ?? 0) + group._count._all,
    )
  }

  return buildCustomerStatePreservationContext({
    tenantId: tenant.id,
    tenantStatus: tenant.status,
    billingStatus: tenant.billingAccount?.status ?? null,
    evidenceBounded,
    venues: venues.map((venue) => ({
      id: venue.id,
      name: venue.name,
      isActive: venue.isActive,
      placeRecordCount: venue._count.places,
      knowledgeRecordCount: venue._count.knowledgeEntries,
      packageRecordCount: packageCountByVenue.get(venue.id) ?? 0,
      manifestRecordCount: venue._count.venuePackageManifestArtifacts,
      hasBotConfigurationRecord: Boolean(venue.venueBotConfiguration),
      latestPlan: latestPlanByVenue.get(venue.id) ?? null,
    })),
  })
}
