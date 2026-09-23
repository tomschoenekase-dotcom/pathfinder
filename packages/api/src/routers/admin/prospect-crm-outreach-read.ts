import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, getProspectOutreachAnalyticsAction, withTenantIsolationBypass } from '@pathfinder/db'

import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'

const id = z.string().min(1).max(191)
const campaignCursor = z
  .object({ version: z.literal(2), campaignId: id, createdAt: z.string().datetime(), id })
  .strict()
const CAMPAIGN_MEMBER_PAGE = 50
const CAMPAIGN_BATCH_PAGE = 20
const CAMPAIGN_DELIVERY_PAGE = 50

export const adminProspectCrmOutreachReadRouter = router({
  listProspectCampaigns: adminProcedure.use(requireCrmProspectOutreach).query(() =>
    withTenantIsolationBypass(() =>
      db.prospectOutreachCampaign.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { _count: { select: { members: true, drafts: true, sendBatches: true } } },
      }),
    ),
  ),

  getProspectOutreachAnalytics: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ campaignId: id.optional() }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(() =>
        getProspectOutreachAnalyticsAction(
          input.campaignId === undefined ? {} : { campaignId: input.campaignId },
        ),
      ),
    ),

  getProspectCampaign: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ campaignId: id, detailVersion: z.literal(2).default(2) }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const campaign = await db.prospectOutreachCampaign.findUnique({
          where: { id: input.campaignId },
          include: {
            members: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: CAMPAIGN_MEMBER_PAGE + 1,
              include: {
                organization: {
                  select: { canonicalName: true, relationshipTier: true, priority: true },
                },
                venue: { select: { name: true, city: true, region: true } },
                contact: {
                  select: { fullName: true, title: true, email: true, doNotContact: true },
                },
                drafts: { orderBy: { version: 'desc' }, take: 1 },
              },
            },
            sendBatches: {
              orderBy: { createdAt: 'desc' },
              take: CAMPAIGN_BATCH_PAGE + 1,
              include: {
                _count: { select: { items: true } },
                items: {
                  orderBy: { createdAt: 'asc' },
                  take: CAMPAIGN_DELIVERY_PAGE + 1,
                  select: {
                    id: true,
                    status: true,
                    recipientEmailSnapshot: true,
                    subjectSnapshot: true,
                    contentHashSnapshot: true,
                    providerAccountId: true,
                    providerMessageId: true,
                  },
                },
              },
            },
          },
        })
        if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' })
        const members = campaign.members.slice(0, CAMPAIGN_MEMBER_PAGE)
        const sendBatches = campaign.sendBatches.slice(0, CAMPAIGN_BATCH_PAGE).map((batch) => ({
          ...batch,
          items: batch.items.slice(0, CAMPAIGN_DELIVERY_PAGE),
          page: {
            hasMoreItems: batch.items.length > CAMPAIGN_DELIVERY_PAGE,
            itemLimit: CAMPAIGN_DELIVERY_PAGE,
          },
        }))
        return {
          ...campaign,
          members,
          sendBatches,
          detailVersion: 2 as const,
          page: {
            hasMoreMembers: campaign.members.length > CAMPAIGN_MEMBER_PAGE,
            hasMoreBatches: campaign.sendBatches.length > CAMPAIGN_BATCH_PAGE,
            memberLimit: CAMPAIGN_MEMBER_PAGE,
            batchLimit: CAMPAIGN_BATCH_PAGE,
          },
        }
      }),
    ),

  listProspectCampaignMembers: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          campaignId: id,
          limit: z.number().int().min(1).max(100).default(50),
          cursor: campaignCursor.optional(),
          detailVersion: z.literal(2).default(2),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (input.cursor && input.cursor.campaignId !== input.campaignId)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Campaign cursor does not match this campaign',
          })
        const createdAt = input.cursor ? new Date(input.cursor.createdAt) : null
        const rows = await db.prospectCampaignMember.findMany({
          where: {
            campaignId: input.campaignId,
            ...(createdAt && input.cursor
              ? {
                  OR: [
                    { createdAt: { gt: createdAt } },
                    { createdAt, id: { gt: input.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: input.limit + 1,
          include: {
            organization: {
              select: { canonicalName: true, relationshipTier: true, priority: true },
            },
            venue: { select: { name: true, city: true, region: true } },
            contact: { select: { fullName: true, title: true, email: true, doNotContact: true } },
            drafts: { orderBy: { version: 'desc' }, take: 1 },
          },
        })
        const items = rows.slice(0, input.limit)
        const last = items.at(-1)
        return {
          detailVersion: 2 as const,
          items,
          nextCursor:
            rows.length > input.limit && last
              ? {
                  version: 2 as const,
                  campaignId: input.campaignId,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                }
              : null,
        }
      }),
    ),

  listProspectCampaignDeliveries: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          campaignId: id,
          limit: z.number().int().min(1).max(100).default(50),
          cursor: campaignCursor.optional(),
          detailVersion: z.literal(2).default(2),
        })
        .strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (input.cursor && input.cursor.campaignId !== input.campaignId)
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Campaign cursor does not match this campaign',
          })
        const createdAt = input.cursor ? new Date(input.cursor.createdAt) : null
        const rows = await db.prospectSendItem.findMany({
          where: {
            batch: { campaignId: input.campaignId },
            ...(createdAt && input.cursor
              ? {
                  OR: [
                    { createdAt: { lt: createdAt } },
                    { createdAt, id: { lt: input.cursor.id } },
                  ],
                }
              : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit + 1,
          select: {
            id: true,
            batchId: true,
            status: true,
            recipientEmailSnapshot: true,
            subjectSnapshot: true,
            contentHashSnapshot: true,
            providerAccountId: true,
            providerMessageId: true,
            createdAt: true,
          },
        })
        const items = rows.slice(0, input.limit)
        const last = items.at(-1)
        return {
          detailVersion: 2 as const,
          items,
          nextCursor:
            rows.length > input.limit && last
              ? {
                  version: 2 as const,
                  campaignId: input.campaignId,
                  createdAt: last.createdAt.toISOString(),
                  id: last.id,
                }
              : null,
        }
      }),
    ),

  getProspectDeliveryMessageBody: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z.object({ campaignId: id, sendItemId: id, detailVersion: z.literal(2).default(2) }).strict(),
    )
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const item = await db.prospectSendItem.findFirst({
          where: { id: input.sendItemId, batch: { campaignId: input.campaignId } },
          select: {
            id: true,
            contentHashSnapshot: true,
            textBodySnapshot: true,
            htmlBodySnapshot: true,
          },
        })
        if (!item)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign delivery not found' })
        return { detailVersion: 2 as const, ...item }
      }),
    ),
})
