import type { Prisma } from '@prisma/client'

import { OPERATOR_MCP_INPUTS } from '@pathfinder/contracts/operator-mcp'

import { OperatorNotFoundError } from '../grants'
import type { OperatorReadTool } from '../registry'
import { pageResult, requireCursorInScope } from './page'

/**
 * Identifier discovery. Each tool returns the exact ids another tool needs, so no workflow depends
 * on an id the operator could only learn from the admin UI.
 */

const customersList: OperatorReadTool = {
  name: 'customers.list',
  capability: 'venues:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['customers.list'].parse(raw)
    const grant = context.grant
    const and: Prisma.TenantWhereInput[] = []
    // A connection limited to some tenants can never list or probe another one.
    if (!grant.allTenants) and.push({ id: { in: [...grant.tenantIds] } })
    if (input.query) {
      and.push({
        OR: [
          { name: { contains: input.query, mode: 'insensitive' } },
          { slug: { contains: input.query, mode: 'insensitive' } },
        ],
      })
    }
    const where: Prisma.TenantWhereInput = and.length > 0 ? { AND: and } : {}
    await requireCursorInScope(input.cursor, (id) =>
      context.database.tenant.findFirst({ where: { AND: [where, { id }] }, select: { id: true } }),
    )
    const rows = await context.database.tenant.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        planTier: true,
        updatedAt: true,
        _count: { select: { venues: true } },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        tenantId: row.id,
        name: row.name.slice(0, 200),
        slug: row.slug.slice(0, 200),
        status: row.status,
        planTier: row.planTier.slice(0, 80),
        venueCount: row._count.venues,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

const crmListCampaigns: OperatorReadTool = {
  name: 'crm.list_campaigns',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_campaigns'].parse(raw)
    const where: Prisma.ProspectOutreachCampaignWhereInput = input.status
      ? { status: input.status }
      : {}
    await requireCursorInScope(input.cursor, (id) =>
      context.database.prospectOutreachCampaign.findFirst({
        where: { AND: [where, { id }] },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectOutreachCampaign.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        name: true,
        status: true,
        dailySendCap: true,
        pausedAt: true,
        updatedAt: true,
        _count: { select: { members: true } },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        campaignId: row.id,
        name: row.name.slice(0, 191),
        status: row.status,
        memberCount: row._count.members,
        dailyLimit: row.dailySendCap,
        pausedAt: row.pausedAt ? row.pausedAt.toISOString() : null,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

const crmListCampaignMembers: OperatorReadTool = {
  name: 'crm.list_campaign_members',
  capability: 'crm:read',
  async handler(raw, context) {
    const input = OPERATOR_MCP_INPUTS['crm.list_campaign_members'].parse(raw)
    const campaign = await context.database.prospectOutreachCampaign.findUnique({
      where: { id: input.campaignId },
      select: { id: true },
    })
    if (!campaign) throw new OperatorNotFoundError()
    const where: Prisma.ProspectCampaignMemberWhereInput = {
      campaignId: input.campaignId,
      ...(input.organizationId ? { organizationId: input.organizationId } : {}),
      ...(input.status ? { status: input.status } : {}),
    }
    await requireCursorInScope(input.cursor, (id) =>
      context.database.prospectCampaignMember.findFirst({
        where: { AND: [where, { id }] },
        select: { id: true },
      }),
    )
    const rows = await context.database.prospectCampaignMember.findMany({
      where,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
      ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      select: {
        id: true,
        campaignId: true,
        organizationId: true,
        venueId: true,
        contactId: true,
        status: true,
        updatedAt: true,
        organization: { select: { canonicalName: true } },
        _count: { select: { drafts: true } },
      },
    })
    const page = rows.slice(0, input.limit)
    return pageResult(
      page.map((row) => ({
        campaignMemberId: row.id,
        campaignId: row.campaignId,
        organizationId: row.organizationId,
        organizationName: row.organization.canonicalName.slice(0, 200),
        venueId: row.venueId,
        contactId: row.contactId,
        status: row.status,
        draftCount: row._count.drafts,
        updatedAt: row.updatedAt.toISOString(),
      })),
      rows.length > input.limit ? page.at(-1)!.id : null,
    )
  },
}

export const discoveryReadTools: readonly OperatorReadTool[] = [
  customersList,
  crmListCampaigns,
  crmListCampaignMembers,
]
