import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { AnyVenueLaunchAssetSelectionSchema } from '@pathfinder/contracts/venue-launch-asset'

import {
  db,
  addSourcedProspectCampaignContactAction,
  appendProspectCampaignEmailSourceEvidenceAction,
  admitProspectStagingPackageAction,
  approveProspectStagingPackageCommitAction,
  createProspectCampaignAction,
  evaluateProspectFollowupReadinessAction,
  ProspectOutreachError,
  type VerifiedCurrentProspectPrintAsset,
  reviewProspectOutreachDraftAction,
  saveProspectOutreachDraftAction,
  scheduleProspectFollowupAction,
  selectProspectCampaignContactRouteAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'

import { mergeRouters, router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'
import { prospectActor, prospectBoundedText } from './prospect-crm-common'
import { getProspectOutreachReadinessProjection } from './prospect-crm-followup-review'
import { getProspectNoSendRehearsalProjection } from './prospect-outreach-rehearsal'
import { adminProspectCrmOutreachReadRouter } from './prospect-crm-outreach-read'
import { adminProspectCrmOutreachGmailRouter } from './prospect-crm-outreach-gmail'
import { adminProspectCrmOutreachDeliveryRouter } from './prospect-crm-outreach-delivery'
import { enqueueProspectImportCommit } from '@pathfinder/jobs'
import { selectProspectLaunchAsset } from '../../prospect-launch-assets'
import { descriptorOnlyDraft, frozenPdfProofs } from './prospect-crm-outreach-assets'

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

const adminProspectCrmOutreachBaseActionsRouter = router({
  appendProspectCampaignEmailSourceEvidence: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          memberId: id,
          email: z.string().trim().email().max(320),
          sourceUrl: z.string().trim().min(1).max(2048),
          sourceLabel: z.string().trim().max(300).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        appendProspectCampaignEmailSourceEvidenceAction({
          memberId: input.memberId,
          email: input.email,
          sourceUrl: input.sourceUrl,
          ...(input.sourceLabel !== undefined ? { sourceLabel: input.sourceLabel } : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  addSourcedProspectCampaignContact: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          memberId: id,
          email: z.string().trim().email().max(320),
          sourceEvidenceId: id,
          fullName: z.string().trim().max(300).optional(),
          title: z.string().trim().max(300).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        addSourcedProspectCampaignContactAction({
          memberId: input.memberId,
          email: input.email,
          sourceEvidenceId: input.sourceEvidenceId,
          ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

  selectProspectCampaignContactRoute: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ memberId: id, contactId: id }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        selectProspectCampaignContactRouteAction({
          ...input,
          actor: prospectActor(ctx.session.userId),
        }).catch(mapError),
      ),
    ),

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

const adminProspectCrmOutreachActionsRouter = mergeRouters(
  adminProspectCrmOutreachBaseActionsRouter,
  adminProspectCrmOutreachGmailRouter,
  adminProspectCrmOutreachDeliveryRouter,
)

export const adminProspectCrmOutreachRouter = mergeRouters(
  adminProspectCrmOutreachReadRouter,
  adminProspectCrmOutreachActionsRouter,
)
