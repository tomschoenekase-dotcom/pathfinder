import type { Prisma } from '@prisma/client'

import type { OperatorDatabase } from '../audit'
import {
  buildProspectAgentSnapshotOrganization,
  emptySnapshotOutreach,
  operatorOrganizationVersion,
  OPERATOR_OUTREACH_LOG_ACTIVITY_TYPE,
  type SnapshotOutreachInput,
} from '../crm-projection'

/**
 * Prospect tables are platform-scoped (no tenantId), so CRM reads need no tenant predicate. Every
 * read here excludes archived rows and selects only the fields the projection needs; email bodies,
 * provenance, actor identities and provider IDs are never selected.
 */
export const organizationSelect = {
  id: true,
  canonicalName: true,
  website: true,
  organizationType: true,
  headquartersCity: true,
  headquartersRegion: true,
  headquartersCountry: true,
  relationshipTier: true,
  notes: true,
  updatedAt: true,
  opportunity: {
    select: {
      stage: true,
      priority: true,
      nextAction: true,
      nextActionAt: true,
      lastActivityAt: true,
    },
  },
  venues: {
    where: { archivedAt: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      name: true,
      website: true,
      venueType: true,
      city: true,
      region: true,
      country: true,
      estimatedSize: true,
      fitAttributes: true,
    },
  },
  contacts: {
    where: { archivedAt: null },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      venueId: true,
      fullName: true,
      title: true,
      email: true,
      phone: true,
      emailReadiness: true,
      permissionState: true,
      doNotContact: true,
      suppressionReason: true,
      suppressedAt: true,
      unsubscribedAt: true,
      complainedAt: true,
      lastHardBounceAt: true,
      notes: true,
    },
  },
  tagAssignments: {
    select: { tag: { select: { slug: true, label: true, archivedAt: true } } },
  },
} satisfies Prisma.ProspectOrganizationSelect

export type LoadedOrganization = Prisma.ProspectOrganizationGetPayload<{
  select: typeof organizationSelect
}>

export async function loadOutreach(
  database: OperatorDatabase,
  organizationIds: string[],
): Promise<Map<string, SnapshotOutreachInput>> {
  const outreach = new Map<string, SnapshotOutreachInput>(
    organizationIds.map((id) => [id, emptySnapshotOutreach()]),
  )
  if (organizationIds.length === 0) return outreach
  const where = { organizationId: { in: organizationIds } }
  const [messages, threads, drafts, members, duplicates, activities] = await Promise.all([
    database.prospectEmailMessage.groupBy({
      by: ['organizationId', 'direction'],
      where,
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    database.prospectEmailThread.groupBy({
      by: ['organizationId'],
      where,
      _count: { _all: true },
    }),
    database.prospectOutreachDraft.groupBy({
      by: ['organizationId', 'status'],
      where,
      _count: { _all: true },
    }),
    database.prospectCampaignMember.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        organizationId: true,
        status: true,
        campaign: { select: { name: true, status: true } },
      },
    }),
    database.prospectDuplicateCandidate.findMany({
      where: {
        status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
        OR: [
          { organizationAId: { in: organizationIds } },
          { organizationBId: { in: organizationIds } },
        ],
      },
      select: { organizationAId: true, organizationBId: true, status: true },
    }),
    database.prospectActivity.groupBy({
      by: ['organizationId', 'type'],
      // OUTREACH_SENT is also the type `crm.log_outreach_sent` writes.
      where: { ...where, type: { in: [OPERATOR_OUTREACH_LOG_ACTIVITY_TYPE, 'REPLY_RECEIVED'] } },
      _max: { occurredAt: true },
    }),
  ])
  const entry = (id: string) => outreach.get(id)
  for (const row of messages) {
    const target = entry(row.organizationId)
    if (!target) continue
    const side = row.direction === 'OUTBOUND' ? target.outbound : target.inbound
    side.count = row._count._all
    side.last = row._max.occurredAt
  }
  for (const row of threads) {
    const target = entry(row.organizationId)
    if (target) target.threadCount = row._count._all
  }
  for (const row of drafts) {
    const target = entry(row.organizationId)
    if (target) target.draftsByStatus[row.status] = row._count._all
  }
  for (const row of members) {
    entry(row.organizationId)?.campaigns.push({
      name: row.campaign.name,
      campaignStatus: row.campaign.status,
      memberStatus: row.status,
    })
  }
  for (const row of duplicates) {
    for (const id of [row.organizationAId, row.organizationBId]) {
      const target = entry(id)
      if (!target) continue
      if (target.duplicateReview !== 'CONFIRMED_DUPLICATE') {
        target.duplicateReview = row.status as 'OPEN' | 'CONFIRMED_DUPLICATE'
      }
    }
  }
  for (const row of activities) {
    const target = entry(row.organizationId)
    if (!target) continue
    if (row.type === OPERATOR_OUTREACH_LOG_ACTIVITY_TYPE) {
      target.activity.lastOutreachSentAt = row._max.occurredAt
    }
    if (row.type === 'REPLY_RECEIVED') target.activity.lastReplyReceivedAt = row._max.occurredAt
  }
  return outreach
}

export async function loadActivityCounts(
  database: OperatorDatabase,
  organizationIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>(organizationIds.map((id) => [id, 0]))
  if (organizationIds.length === 0) return counts
  const rows = await database.prospectActivity.groupBy({
    by: ['organizationId'],
    where: { organizationId: { in: organizationIds } },
    _count: { _all: true },
  })
  for (const row of rows) counts.set(row.organizationId, row._count._all)
  return counts
}

export function projectOrganization(
  organization: LoadedOrganization,
  outreach: SnapshotOutreachInput | undefined,
  activityCount: number,
) {
  const record = buildProspectAgentSnapshotOrganization(
    organization,
    outreach ?? emptySnapshotOutreach(),
  )
  const version = operatorOrganizationVersion(activityCount)
  return { record, version }
}
