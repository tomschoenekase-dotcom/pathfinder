import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  approveProspectSendBatchAction,
  createProspectCampaignAction,
  db,
  ProspectOutreachError,
  publishCrmOperationalSignal,
  releaseProspectSendBatchAction,
  reviewProspectOutreachDraftAction,
  saveProspectOutreachDraftAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
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
            customerRelationships: {
              where: { status: 'ACTIVE' },
              take: 10,
              orderBy: { startedAt: 'desc' },
              select: {
                tenantId: true,
                startedAt: true,
                locationConversions: {
                  where: { status: 'ACTIVE' },
                  take: 50,
                  orderBy: { convertedAt: 'desc' },
                  select: { venueId: true, convertedAt: true },
                },
              },
            },
          },
        })
        if (!prospect) throw new TRPCError({ code: 'NOT_FOUND', message: 'Prospect not found' })
        const links = prospect.customerRelationships.flatMap((relationship) =>
          relationship.locationConversions.map((location) => ({
            tenantId: relationship.tenantId,
            venueId: location.venueId,
            convertedAt: location.convertedAt,
          })),
        )
        if (!links.length) return { prospect, liveVenue: null, liveVenues: [] }
        const primary = links[0]!
        const [venue, places, knowledge] = await Promise.all([
          db.venue.findFirst({
            where: { id: primary.venueId, tenantId: primary.tenantId },
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
              venueId: primary.venueId,
              tenantId: primary.tenantId,
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
              venueId: primary.venueId,
              tenantId: primary.tenantId,
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
        const liveVenues = await db.venue.findMany({
          where: { OR: links.map((link) => ({ id: link.venueId, tenantId: link.tenantId })) },
          select: {
            id: true,
            tenantId: true,
            name: true,
            slug: true,
            category: true,
            isActive: true,
          },
        })
        return { prospect, liveVenue: venue ? { ...venue, places, knowledge } : null, liveVenues }
      }),
    ),

  listProspectCampaigns: adminProcedure.use(requireCrmProspectOutreach).query(() =>
    withTenantIsolationBypass(() =>
      db.prospectOutreachCampaign.findMany({
        orderBy: { updatedAt: 'desc' },
        take: 200,
        include: { _count: { select: { members: true, drafts: true, sendBatches: true } } },
      }),
    ),
  ),

  getProspectCampaign: adminProcedure
    .use(requireCrmProspectOutreach)
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
              include: {
                _count: { select: { items: true } },
                items: {
                  orderBy: { createdAt: 'asc' },
                  select: {
                    id: true,
                    status: true,
                    recipientEmailSnapshot: true,
                    subjectSnapshot: true,
                    textBodySnapshot: true,
                    htmlBodySnapshot: true,
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
        return campaign
      }),
    ),

  createProspectCampaign: adminProcedure
    .use(requireCrmProspectOutreach)
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
    .use(requireCrmProspectOutreach)
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
    .use(requireCrmProspectOutreach)
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
    .use(requireCrmProspectOutreach)
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
    .use(requireCrmProspectOutreach)
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
      withTenantIsolationBypass(async () => {
        const approved = await approveProspectSendBatchAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError)
        await publishCrmOperationalSignal({
          input: {
            signal: 'batch_awaiting_release',
            scope: { kind: 'platform' },
            linkedObjectType: 'ProspectSendBatch',
            linkedObjectId: approved.id,
            summary: `A frozen batch of ${approved.recipientCount} recipients is approved and awaiting a separate final release.`,
          },
        })
        return approved
      }),
    ),

  queueProspectSendBatch: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          batchId: id,
          expectedRecipientCount: z.number().int().min(1).max(500),
          expectedSnapshotHash: z.string().length(64),
          providerAccountId: id,
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        if (process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED !== 'true') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Prospect outreach delivery is disabled',
          })
        }
        const released = await releaseProspectSendBatchAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError)
        const dispatch = await Promise.allSettled(
          released.outboxIds.map((outboxId) => enqueueProspectOutreach({ outboxId })),
        )
        return {
          ...released,
          dispatched: dispatch.filter((result) => result.status === 'fulfilled').length,
          pendingDispatch: dispatch.filter((result) => result.status === 'rejected').length,
        }
      }),
    ),

  getProspectOutreachReadiness: adminProcedure.use(requireCrmProspectOutreach).query(() =>
    withTenantIsolationBypass(async () => {
      const [control, accounts] = await Promise.all([
        db.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
        db.correspondenceProviderAccount.findMany({
          where: { provider: 'GMAIL' },
          select: {
            id: true,
            mailboxAddress: true,
            connectionStatus: true,
            deliveryEnabled: true,
            pausedAt: true,
            lastSuccessfulSyncAt: true,
            lastReconciliationAt: true,
            watchExpiration: true,
            healthErrorCode: true,
            healthErrorSummary: true,
          },
          orderBy: { mailboxAddress: 'asc' },
        }),
      ])
      return {
        deliveryEnabled:
          process.env.PROSPECT_OUTREACH_DELIVERY_ENABLED === 'true' &&
          Boolean(control?.deliveryEnabled),
        internalOnly: control?.internalOnly ?? true,
        providerConfigured: accounts.some(
          (account) => account.connectionStatus === 'CONNECTED' && account.deliveryEnabled,
        ),
        provider: 'GMAIL' as const,
        accounts,
        limits: { cohort: 5000, batch: 500 },
        policy: { agentsMayDraft: true, agentsMayApprove: false, agentsMaySend: false },
      }
    }),
  ),
})
