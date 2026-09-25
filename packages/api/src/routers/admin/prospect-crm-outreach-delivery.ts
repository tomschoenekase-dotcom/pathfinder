import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import {
  approveProspectSendBatchAction,
  emergencyStopProspectDeliveryAction,
  ProspectOutreachError,
  PROSPECT_OUTREACH_RELEASE_POLICY,
  publishCrmOperationalSignal,
  releaseProspectSendBatchAction,
  stageProspectSendBatchAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueProspectOutreach } from '@pathfinder/jobs'
import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'
import { prospectActor, prospectBoundedText } from './prospect-crm-common'
import { currentBatchPdfProofs, currentDraftPdfProofs } from './prospect-crm-outreach-assets'

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

export const adminProspectCrmOutreachDeliveryRouter = router({
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
})
