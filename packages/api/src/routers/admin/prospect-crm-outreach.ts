import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  approveProspectSendBatchAction,
  createProspectCampaignAction,
  db,
  ProspectOutreachError,
  reviewProspectOutreachDraftAction,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { prospectActor, prospectBoundedText } from './prospect-crm-common'
import { enqueueProspectOutreach } from '@pathfinder/jobs'

const id = z.string().min(1).max(191)
function mapError(error: unknown): never {
  if (!(error instanceof ProspectOutreachError)) throw error
  const code =
    error.code === 'NOT_FOUND'
      ? 'NOT_FOUND'
      : error.code === 'CONFLICT'
        ? 'CONFLICT'
        : 'BAD_REQUEST'
  throw new TRPCError({ code, message: error.message })
}

export const adminProspectCrmOutreachRouter = router({
  listProspectSavedViews: adminProcedure.query(({ ctx }) =>
    withTenantIsolationBypass(() =>
      db.prospectSavedView.findMany({
        where: { OR: [{ ownerId: ctx.session.userId }, { isShared: true }] },
        orderBy: [{ ownerId: 'asc' }, { name: 'asc' }],
      }),
    ),
  ),

  saveProspectView: adminProcedure
    .input(
      z
        .object({
          name: prospectBoundedText(191),
          filters: z.record(z.unknown()),
          columns: z.array(z.string().trim().min(1).max(100)).max(20),
          sort: z.record(z.unknown()).default({}),
          isShared: z.boolean().default(false),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        db.prospectSavedView.upsert({
          where: { ownerId_name: { ownerId: ctx.session.userId, name: input.name } },
          create: { ...input, ownerId: ctx.session.userId },
          update: input,
        }),
      ),
    ),

  deleteProspectView: adminProcedure
    .input(z.object({ viewId: id }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const deleted = await db.prospectSavedView.deleteMany({
          where: { id: input.viewId, ownerId: ctx.session.userId },
        })
        if (!deleted.count)
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Saved view not found' })
        return { deleted: true }
      }),
    ),

  getProspectIntelligence: adminProcedure
    .input(z.object({ organizationId: id }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const prospect = await db.prospectOrganization.findUnique({
          where: { id: input.organizationId },
          select: {
            id: true,
            canonicalName: true,
            relationshipTier: true,
            description: true,
            researchProvenance: true,
            tags: true,
            conversion: { select: { tenantId: true, venueId: true, convertedAt: true } },
          },
        })
        if (!prospect) throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect not found' })
        if (!prospect.conversion?.venueId) return { prospect, liveVenue: null }
        const [venue, places, knowledge] = await Promise.all([
          db.venue.findFirst({
            where: { id: prospect.conversion.venueId, tenantId: prospect.conversion.tenantId },
            select: {
              id: true,
              tenantId: true,
              name: true,
              slug: true,
              category: true,
              isActive: true,
              updatedAt: true,
            },
          }),
          db.place.findMany({
            where: {
              venueId: prospect.conversion.venueId,
              tenantId: prospect.conversion.tenantId,
              isActive: true,
            },
            orderBy: [{ importanceScore: 'desc' }, { name: 'asc' }],
            take: 100,
            select: {
              id: true,
              name: true,
              type: true,
              itemType: true,
              shortDescription: true,
              areaName: true,
              tags: true,
              updatedAt: true,
            },
          }),
          db.venueKnowledgeEntry.findMany({
            where: {
              venueId: prospect.conversion.venueId,
              tenantId: prospect.conversion.tenantId,
              isEnabled: true,
            },
            orderBy: { updatedAt: 'desc' },
            take: 100,
            select: {
              id: true,
              title: true,
              category: true,
              content: true,
              sourceType: true,
              humanConfirmedAt: true,
              updatedAt: true,
            },
          }),
        ])
        return { prospect, liveVenue: venue ? { ...venue, places, knowledge } : null }
      }),
    ),

  listProspectCampaigns: adminProcedure.query(() =>
    withTenantIsolationBypass(() =>
      db.prospectOutreachCampaign.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { _count: { select: { members: true, drafts: true, sendBatches: true } } },
      }),
    ),
  ),

  getProspectCampaign: adminProcedure
    .input(z.object({ campaignId: id }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const campaign = await db.prospectOutreachCampaign.findUnique({
          where: { id: input.campaignId },
          include: {
            members: {
              orderBy: { createdAt: 'asc' },
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
              include: { _count: { select: { items: true } } },
            },
          },
        })
        if (!campaign) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' })
        return campaign
      }),
    ),

  createProspectCampaign: adminProcedure
    .input(
      z
        .object({
          name: prospectBoundedText(191),
          description: z.string().trim().max(2000).optional(),
          organizationIds: z.array(id).min(1).max(5000),
          cohortSnapshot: z.record(z.unknown()),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        createProspectCampaignAction({
          name: input.name,
          organizationIds: input.organizationIds,
          cohortSnapshot: input.cohortSnapshot,
          ...(input.description !== undefined ? { description: input.description } : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  saveProspectOutreachDraft: adminProcedure
    .input(
      z
        .object({
          memberId: id,
          subject: prospectBoundedText(998),
          textBody: prospectBoundedText(50_000),
          htmlBody: z.string().max(100_000).optional(),
          groundingSnapshot: z.record(z.unknown()),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        saveProspectOutreachDraftAction({
          memberId: input.memberId,
          subject: input.subject,
          textBody: input.textBody,
          groundingSnapshot: input.groundingSnapshot,
          ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  reviewProspectOutreachDraft: adminProcedure
    .input(
      z
        .object({
          draftId: id,
          approve: z.boolean(),
          reason: z.string().trim().max(2000).optional(),
          acknowledgedEscalations: z.array(z.string().trim().max(100)).max(20).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        reviewProspectOutreachDraftAction({
          draftId: input.draftId,
          approve: input.approve,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.acknowledgedEscalations !== undefined
            ? { acknowledgedEscalations: input.acknowledgedEscalations }
            : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  stageProspectSendBatch: adminProcedure
    .input(
      z
        .object({
          campaignId: id,
          draftIds: z.array(id).min(1).max(500),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        stageProspectSendBatchAction({ ...input, actor: prospectActor(ctx.session.userId) }).catch(
          mapError,
        ),
      ),
    ),

  approveProspectSendBatch: adminProcedure
    .input(
      z
        .object({
          batchId: id,
          expectedRecipientCount: z.number().int().min(1).max(500),
          expectedSnapshotHash: z.string().length(64),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        approveProspectSendBatchAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  queueProspectSendBatch: adminProcedure
    .input(
      z
        .object({
          batchId: id,
          expectedRecipientCount: z.number().int().min(1).max(500),
          expectedSnapshotHash: z.string().length(64),
        })
        .strict(),
    )
    .mutation(({ input }) =>
      withTenantIsolationBypass(async () => {
        if (process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED !== 'true') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Prospect outreach delivery is disabled',
          })
        }
        if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Outreach provider is not configured',
          })
        }
        const batch = await db.prospectSendBatch.findUnique({
          where: { id: input.batchId },
          include: { items: true },
        })
        if (!batch || batch.status !== 'APPROVED')
          throw new TRPCError({ code: 'CONFLICT', message: 'Batch is not approved' })
        if (
          batch.recipientCount !== input.expectedRecipientCount ||
          batch.snapshotHash !== input.expectedSnapshotHash ||
          batch.items.length !== batch.recipientCount
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Send confirmation does not match the frozen batch',
          })
        }
        await Promise.all(
          batch.items.map((item) => enqueueProspectOutreach({ sendItemId: item.id })),
        )
        await db.$transaction([
          db.prospectSendItem.updateMany({
            where: { batchId: batch.id, status: 'STAGED' },
            data: { status: 'QUEUED' },
          }),
          db.prospectSendBatch.update({
            where: { id: batch.id },
            data: { status: 'QUEUED', queuedAt: new Date() },
          }),
        ])
        return { queued: batch.items.length }
      }),
    ),

  getProspectOutreachReadiness: adminProcedure.query(() => ({
    deliveryEnabled: process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED === 'true',
    providerConfigured: Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
    inboundConfigured: Boolean(
      process.env.RESEND_WEBHOOK_SECRET && process.env.PROSPECT_OUTREACH_REPLY_DOMAIN,
    ),
    limits: { cohort: 5000, batch: 500 },
    policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
  })),
})
