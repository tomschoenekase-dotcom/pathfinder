import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AnyVenueLaunchAssetSelectionSchema } from '@pathfinder/contracts/venue-launch-asset'

import {
  db,
  admitProspectStagingPackageAction,
  approveProspectSendBatchAction,
  approveProspectStagingPackageCommitAction,
  createProspectCampaignAction,
  emergencyStopProspectDeliveryAction,
  evaluateProspectFollowupReadinessAction,
  ProspectOutreachError,
  PROSPECT_OUTREACH_RELEASE_POLICY,
  type VerifiedCurrentProspectPrintAsset,
  publishCrmOperationalSignal,
  releaseProspectSendBatchAction,
  reviewProspectOutreachDraftAction,
  saveProspectOutreachDraftAction,
  scheduleProspectFollowupAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'
import { prospectActor, prospectBoundedText } from './prospect-crm-common'
import { getProspectOutreachReadinessProjection } from './prospect-crm-followup-review'
import { getProspectNoSendRehearsalProjection } from './prospect-outreach-rehearsal'
import { adminProspectCrmOutreachReadRouter } from './prospect-crm-outreach-read'
import { enqueueProspectImportCommit, enqueueProspectOutreach } from '@pathfinder/jobs'
import { selectProspectLaunchAsset } from '../../prospect-launch-assets'
import {
  currentBatchPdfProofs,
  currentDraftPdfProofs,
  descriptorOnlyDraft,
  frozenPdfProofs,
} from './prospect-crm-outreach-assets'

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

const adminProspectCrmOutreachActionsRouter = router({
  admitProspectStagingPackage: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ package: z.unknown() }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        admitProspectStagingPackageAction({
          package: input.package,
          actor: prospectActor(ctx.session.userId),
        }),
      ),
    ),

  approveProspectStagingPackageCommit: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ importId: id }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const approved = await approveProspectStagingPackageCommitAction({
          importId: input.importId,
          actor: prospectActor(ctx.session.userId),
        })
        await enqueueProspectImportCommit({ importId: input.importId })
        return approved
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
          launchAssetSelection: AnyVenueLaunchAssetSelectionSchema.optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const snapshot = input.groundingSnapshot
        if (Object.prototype.hasOwnProperty.call(snapshot, 'launchAttachments')) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Supply a current asset selection, not attachment bytes',
          })
        }
        let groundingSnapshot: Record<string, unknown> = snapshot
        let verifiedCurrentPrintAssets: VerifiedCurrentProspectPrintAsset[] = []
        if (input.launchAssetSelection) {
          const member = await db.prospectCampaignMember.findUnique({
            where: { id: input.memberId },
            select: { venueId: true },
          })
          if (!member?.venueId)
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'A converted prospect venue is required for this asset',
            })
          const asset = await selectProspectLaunchAsset(
            member.venueId,
            input.launchAssetSelection,
          ).catch(() => {
            throw new TRPCError({
              code: 'CONFLICT',
              message: 'Selected venue QR is stale; list current assets and choose again',
            })
          })
          groundingSnapshot = { ...snapshot, launchAttachments: [asset] }
          if (asset.schema === 'torchiko.venue-launch-asset/2' && asset.format === 'PDF') {
            verifiedCurrentPrintAssets = [{ prospectVenueId: member.venueId, asset }]
          }
        }
        const saved = await saveProspectOutreachDraftAction({
          memberId: input.memberId,
          subject: input.subject,
          textBody: input.textBody,
          groundingSnapshot,
          verifiedCurrentPrintAssets,
          ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError)
        return descriptorOnlyDraft(saved)
      }),
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
      withTenantIsolationBypass(async () => {
        const draft = await db.prospectOutreachDraft.findUnique({
          where: { id: input.draftId },
          select: { venueId: true, groundingSnapshot: true },
        })
        const verifiedCurrentPrintAssets = draft
          ? await frozenPdfProofs([
              { prospectVenueId: draft.venueId, snapshot: draft.groundingSnapshot },
            ])
          : []
        const reviewed = await reviewProspectOutreachDraftAction({
          draftId: input.draftId,
          approve: input.approve,
          verifiedCurrentPrintAssets,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.acknowledgedEscalations !== undefined
            ? { acknowledgedEscalations: input.acknowledgedEscalations }
            : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError)
        return descriptorOnlyDraft(reviewed)
      }),
    ),

  stageProspectSendBatch: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          campaignId: id,
          draftIds: z.array(id).min(1).max(PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () =>
        stageProspectSendBatchAction({
          ...input,
          verifiedCurrentPrintAssets: await currentDraftPdfProofs(input.draftIds),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  approveProspectSendBatch: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          batchId: id,
          expectedRecipientCount: z
            .number()
            .int()
            .min(1)
            .max(PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients),
          expectedSnapshotHash: z.string().length(64),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(async () => {
        const approved = await approveProspectSendBatchAction({
          ...input,
          verifiedCurrentPrintAssets: await currentBatchPdfProofs(input.batchId),
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
          expectedRecipientCount: z
            .number()
            .int()
            .min(1)
            .max(PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients),
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
          verifiedCurrentPrintAssets: await currentBatchPdfProofs(input.batchId),
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

  getProspectOutreachReadiness: adminProcedure
    .use(requireCrmProspectOutreach)
    .query(() => withTenantIsolationBypass(() => getProspectOutreachReadinessProjection())),

  getProspectNoSendRehearsal: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ campaignId: id }).strict())
    .query(({ input }) =>
      withTenantIsolationBypass(async () => {
        const rehearsal = await getProspectNoSendRehearsalProjection(input.campaignId)
        if (!rehearsal) throw new TRPCError({ code: 'NOT_FOUND', message: 'Campaign not found' })
        return rehearsal
      }),
    ),

  emergencyStopProspectDelivery: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ reason: prospectBoundedText(2_000) }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        emergencyStopProspectDeliveryAction({
          reason: input.reason,
          actor: prospectActor(ctx.session.userId),
        }),
      ),
    ),

  scheduleProspectFollowup: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          triggerSendItemId: id,
          sequenceNumber: z.union([z.literal(1), z.literal(2)]),
          dueAt: z.coerce.date(),
          reason: prospectBoundedText(1_000),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        scheduleProspectFollowupAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }),
      ),
    ),

  recheckProspectFollowup: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ followupId: id }).strict())
    .mutation(({ input }) =>
      withTenantIsolationBypass(() =>
        evaluateProspectFollowupReadinessAction({ followupId: input.followupId }),
      ),
    ),
})

export const adminProspectCrmOutreachRouter = mergeRouters(
  adminProspectCrmOutreachReadRouter,
  adminProspectCrmOutreachActionsRouter,
)
