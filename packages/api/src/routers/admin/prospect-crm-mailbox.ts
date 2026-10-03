import { TRPCError } from '@trpc/server'
import { z } from 'zod'
import { db, withTenantIsolationBypass, writeAuditLogStrict } from '@pathfinder/db'
import { enqueueGmailSync, GMAIL_SYNC_QUEUE } from '@pathfinder/jobs'

import { router } from '../../core'
import { requireCrmProspectOutreach } from '../../middleware/require-crm-prospect-outreach'
import { adminProcedure } from '../../trpc'

const id = z.string().min(1).max(191)

export const adminProspectCrmMailboxRouter = router({
  requestGmailReconciliation: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(z.object({ providerAccountId: id, requestId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      const account = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.findFirst({
          where: {
            id: input.providerAccountId,
            provider: 'GMAIL',
            connectionStatus: { in: ['CONNECTED', 'DEGRADED'] },
            credentialReferenceId: { not: null },
          },
          select: { id: true },
        }),
      )
      if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Mailbox not found' })
      await writeAuditLogStrict({
        actorId: ctx.session.userId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'admin.gmail_reconciliation.requested',
        targetType: 'CorrespondenceProviderAccount',
        targetId: account.id,
        idempotencyKey: input.requestId,
        afterState: { trigger: 'SCHEDULED_RECONCILIATION' },
      })
      const jobId = await enqueueGmailSync({
        providerAccountId: account.id,
        trigger: 'SCHEDULED_RECONCILIATION',
        requestId: input.requestId,
      })
      return { jobId, status: 'QUEUED' as const }
    }),

  getGmailReconciliation: adminProcedure
    .use(requireCrmProspectOutreach)
    .input(
      z
        .object({ providerAccountId: id, jobId: z.string().regex(/^gmail-sync-[a-f0-9]{64}$/u) })
        .strict(),
    )
    .query(async ({ input }) => {
      const account = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.findFirst({
          where: { id: input.providerAccountId, provider: 'GMAIL' },
          select: { id: true },
        }),
      )
      if (!account) throw new TRPCError({ code: 'NOT_FOUND', message: 'Mailbox not found' })
      const record = await withTenantIsolationBypass(() =>
        db.jobRecord.findUnique({
          where: { queue_bullJobId: { queue: GMAIL_SYNC_QUEUE, bullJobId: input.jobId } },
          select: { status: true, payload: true, error: true, completedAt: true },
        }),
      )
      const details = record?.payload
      const result =
        details && typeof details === 'object' && !Array.isArray(details) ? details : {}
      if (record && result.providerAccountId !== account.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Reconciliation not found' })
      }
      return {
        jobId: input.jobId,
        status: record?.status ?? 'UNKNOWN',
        processed: typeof result.processed === 'number' ? result.processed : null,
        complete: typeof result.complete === 'boolean' ? result.complete : null,
        nextJobId: typeof result.nextJobId === 'string' ? result.nextJobId : null,
        errorCode: record?.error ?? null,
        completedAt: record?.completedAt ?? null,
      }
    }),
})
