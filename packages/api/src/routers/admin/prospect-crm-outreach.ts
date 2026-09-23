import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  admitProspectStagingPackageAction,
  approveProspectSendBatchAction,
  approveProspectStagingPackageCommitAction,
  createProspectCampaignAction,
  emergencyStopProspectDeliveryAction,
  evaluateProspectFollowupReadinessAction,
  ProspectOutreachError,
  PROSPECT_OUTREACH_RELEASE_POLICY,
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
import { verifyNativeOriginRuntime } from '../../prospect-sales-workflow'
import { requestProspectMailboxReconciliation } from '../../prospect-mailbox-reconciliation'
import { readProspectReplyContent, retainProspectReplyContent } from '../../prospect-reply-content'

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
  readProspectReplyContent: adminProcedure.use(requireCrmProspectOutreach)
    .input(z.object({ messageId: id, threadId: id, organizationId: id }).strict())
    .mutation(({ ctx, input }) => readProspectReplyContent(input, ctx.session.userId)),
  retainProspectReplyContent: adminProcedure.use(requireCrmProspectOutreach)
    .input(z.object({ retentionDays: z.number().int().min(1).max(30), expected: z.object({
      canonicalMessageId: id, canonicalThreadId: id, organizationId: id,
      providerAccountId: id, providerMessageId: id, providerThreadId: id,
      sourceReference: z.string().min(1).max(1000), rawBodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    }).strict() }).strict())
    .mutation(({ ctx, input }) => retainProspectReplyContent(input, ctx.session.userId)),
  reconcileProspectMailbox: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ providerAccountId: id, expectedUpdatedAt: z.string().datetime() }).strict())
    .mutation(({ ctx, input }) => withTenantIsolationBypass(() =>
      requestProspectMailboxReconciliation({ ...input, actorId: ctx.session.userId }),
    )),
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
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        saveProspectOutreachDraftAction(
          {
            memberId: input.memberId,
            subject: input.subject,
            textBody: input.textBody,
            groundingSnapshot: input.groundingSnapshot,
            ...(input.htmlBody !== undefined ? { htmlBody: input.htmlBody } : {}),
            actor: prospectActor(ctx.session.userId),
          },
          undefined,
          verifyNativeOriginRuntime,
        ).catch(mapError),
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
          expectedContentHash: z
            .string()
            .regex(/^[a-f0-9]{64}$/u)
            .optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        reviewProspectOutreachDraftAction(
          {
            draftId: input.draftId,
            approve: input.approve,
            ...(input.expectedContentHash !== undefined
              ? { expectedContentHash: input.expectedContentHash }
              : {}),
            ...(input.reason !== undefined ? { reason: input.reason } : {}),
            ...(input.acknowledgedEscalations !== undefined
              ? { acknowledgedEscalations: input.acknowledgedEscalations }
              : {}),
            actor: prospectActor(ctx.session.userId),
          },
          undefined,
          verifyNativeOriginRuntime,
        ).catch(mapError),
      ),
    ),

  stageProspectSendBatch: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          campaignId: id,
          draftIds: z.array(id).min(1).max(PROSPECT_OUTREACH_RELEASE_POLICY.maxRecipients),
          expectedContentHashes: z.record(z.string().regex(/^[a-f0-9]{64}$/u)).optional(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        stageProspectSendBatchAction(
          {
            campaignId: input.campaignId,
            draftIds: input.draftIds,
            ...(input.expectedContentHashes !== undefined
              ? { expectedContentHashes: input.expectedContentHashes }
              : {}),
            actor: prospectActor(ctx.session.userId),
          },
          undefined,
          verifyNativeOriginRuntime,
        ).catch(mapError),
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
        const approved = await approveProspectSendBatchAction(
          {
            ...input,
            actor: prospectActor(ctx.session.userId),
          },
          undefined,
          verifyNativeOriginRuntime,
        ).catch(mapError)
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
        const released = await releaseProspectSendBatchAction(
          {
            ...input,
            actor: prospectActor(ctx.session.userId),
          },
          undefined,
          verifyNativeOriginRuntime,
        ).catch(mapError)
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
