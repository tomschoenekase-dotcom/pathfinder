import { randomUUID } from 'node:crypto'

import { auth } from '@pathfinder/auth/server'
import { db } from '@pathfinder/db'
import { NextResponse } from 'next/server'

import {
  buildProspectAgentSnapshotOrganization,
  emptySnapshotOutreach,
  PROSPECT_AGENT_SNAPSHOT_PAGE_SIZE,
  PROSPECT_AGENT_SNAPSHOT_SCHEMA_VERSION,
  prospectAgentSnapshotFileName,
  prospectAgentSnapshotHeader,
  type SnapshotOutreachInput,
} from '../../../../lib/prospect-agent-snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Prospect tables are platform-scoped, so these reads need no tenant bypass.
async function loadOrganizationPage(cursor: string | undefined) {
  return db.prospectOrganization.findMany({
    where: { archivedAt: null },
    orderBy: { id: 'asc' },
    take: PROSPECT_AGENT_SNAPSHOT_PAGE_SIZE,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
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
        },
      },
      tagAssignments: {
        select: { tag: { select: { slug: true, label: true, archivedAt: true } } },
      },
    },
  })
}

async function loadOutreach(organizationIds: string[]) {
  const where = { organizationId: { in: organizationIds } }
  const [messages, threads, drafts, members, duplicates, activities] = await Promise.all([
    db.prospectEmailMessage.groupBy({
      by: ['organizationId', 'direction'],
      where,
      _count: { _all: true },
      _max: { occurredAt: true },
    }),
    db.prospectEmailThread.groupBy({ by: ['organizationId'], where, _count: { _all: true } }),
    db.prospectOutreachDraft.groupBy({
      by: ['organizationId', 'status'],
      where,
      _count: { _all: true },
    }),
    db.prospectCampaignMember.findMany({
      where,
      orderBy: { id: 'asc' },
      select: {
        organizationId: true,
        status: true,
        campaign: { select: { name: true, status: true } },
      },
    }),
    db.prospectDuplicateCandidate.findMany({
      where: {
        status: { in: ['OPEN', 'CONFIRMED_DUPLICATE'] },
        OR: [
          { organizationAId: { in: organizationIds } },
          { organizationBId: { in: organizationIds } },
        ],
      },
      select: { organizationAId: true, organizationBId: true, status: true },
    }),
    db.prospectActivity.groupBy({
      by: ['organizationId', 'type'],
      where: { ...where, type: { in: ['OUTREACH_SENT', 'REPLY_RECEIVED'] } },
      _max: { occurredAt: true },
    }),
  ])

  const outreach = new Map<string, SnapshotOutreachInput>(
    organizationIds.map((id) => [id, emptySnapshotOutreach()]),
  )
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
      // A confirmed duplicate outranks an open review for the same organization.
      if (target.duplicateReview !== 'CONFIRMED_DUPLICATE') {
        target.duplicateReview = row.status as 'OPEN' | 'CONFIRMED_DUPLICATE'
      }
    }
  }
  for (const row of activities) {
    const target = entry(row.organizationId)
    if (!target) continue
    if (row.type === 'OUTREACH_SENT') target.activity.lastOutreachSentAt = row._max.occurredAt
    if (row.type === 'REPLY_RECEIVED') target.activity.lastReplyReceivedAt = row._max.occurredAt
  }
  return outreach
}

export async function GET() {
  const { userId, sessionClaims } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthenticated' }, { status: 401 })
  const isPlatformAdmin =
    (sessionClaims?.publicMetadata as { platform_role?: string } | undefined)?.platform_role ===
    'PLATFORM_ADMIN'
  if (!isPlatformAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const generatedAt = new Date()
  const snapshotId = randomUUID()
  await db.auditLog.create({
    data: {
      actorId: userId,
      actorRole: 'PLATFORM_ADMIN',
      action: 'admin.prospect-agent-snapshot.downloaded',
      targetType: 'ProspectAgentSnapshot',
      targetId: snapshotId,
      afterState: { schemaVersion: PROSPECT_AGENT_SNAPSHOT_SCHEMA_VERSION },
    },
  })

  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const header = JSON.stringify(prospectAgentSnapshotHeader({ snapshotId, generatedAt }))
        controller.enqueue(encoder.encode(`${header.slice(0, -1)},"organizations":[\n`))
        const counts = { organizations: 0, venues: 0, contacts: 0, suppressedContacts: 0 }
        let cursor: string | undefined
        for (;;) {
          const organizations = await loadOrganizationPage(cursor)
          if (!organizations.length) break
          const outreach = await loadOutreach(organizations.map((organization) => organization.id))
          const chunk = organizations
            .map((organization) => {
              const record = buildProspectAgentSnapshotOrganization(
                organization,
                outreach.get(organization.id) ?? emptySnapshotOutreach(),
              )
              counts.venues += record.venues.length
              counts.contacts += record.contacts.length
              counts.suppressedContacts += record.contacts.filter((c) => c.suppressed).length
              return JSON.stringify(record)
            })
            .join(',\n')
          controller.enqueue(encoder.encode(`${counts.organizations ? ',\n' : ''}${chunk}`))
          counts.organizations += organizations.length
          cursor = organizations.at(-1)!.id
        }
        controller.enqueue(encoder.encode(`\n],"counts":${JSON.stringify(counts)}}\n`))
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${prospectAgentSnapshotFileName(generatedAt)}"`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}
