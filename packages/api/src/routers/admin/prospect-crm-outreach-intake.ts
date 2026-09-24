import { z } from 'zod'
import {
  admitProspectStagingPackageAction,
  approveProspectStagingPackageCommitAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { enqueueProspectImportCommit } from '@pathfinder/jobs'
import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'
import { requestProspectMailboxReconciliation } from '../../prospect-mailbox-reconciliation'
import { readProspectReplyContent, retainProspectReplyContent } from '../../prospect-reply-content'
import { prospectActor } from './prospect-crm-common'

const id = z.string().min(1).max(191)

export const adminProspectCrmOutreachIntakeRouter = router({
  readProspectReplyContent: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ messageId: id, threadId: id, organizationId: id }).strict())
    .mutation(({ ctx, input }) => readProspectReplyContent(input, ctx.session.userId)),
  retainProspectReplyContent: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({
          retentionDays: z.number().int().min(1).max(30),
          expected: z
            .object({
              canonicalMessageId: id,
              canonicalThreadId: id,
              organizationId: id,
              providerAccountId: id,
              providerMessageId: id,
              providerThreadId: id,
              sourceReference: z.string().min(1).max(1000),
              rawBodySha256: z.string().regex(/^[a-f0-9]{64}$/u),
            })
            .strict(),
        })
        .strict(),
    )
    .mutation(({ ctx, input }) => retainProspectReplyContent(input, ctx.session.userId)),
  reconcileProspectMailbox: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ providerAccountId: id, expectedUpdatedAt: z.string().datetime() }).strict())
    .mutation(({ ctx, input }) =>
      withTenantIsolationBypass(() =>
        requestProspectMailboxReconciliation({ ...input, actorId: ctx.session.userId }),
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
})
