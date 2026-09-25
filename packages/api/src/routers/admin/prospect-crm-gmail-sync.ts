import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { db, withTenantIsolationBypass } from '@pathfinder/db'
import { enqueueGmailSync } from '@pathfinder/jobs'

import { router } from '../../core'
import { adminProcedure } from '../../trpc'

export const adminProspectCrmGmailSyncRouter = router({
  requestFullGmailReconciliation: adminProcedure
    .input(
      z
        .object({
          providerAccountId: z
            .string()
            .min(1)
            .max(191)
            .refine((id) => id !== '*' && id.trim() === id),
          requestId: z.string().uuid(),
        })
        .strict(),
    )
    .mutation(({ input }) =>
      withTenantIsolationBypass(async () => {
        const account = await db.correspondenceProviderAccount.findUnique({
          where: { id: input.providerAccountId },
          select: { id: true, provider: true, connectionStatus: true },
        })
        if (!account || account.provider !== 'GMAIL') {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Connected Gmail account was not found',
          })
        }
        if (account.connectionStatus !== 'CONNECTED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Gmail account must be connected before reconciliation',
          })
        }
        await enqueueGmailSync({
          providerAccountId: account.id,
          trigger: 'FULL_RECONCILIATION',
          requestId: input.requestId,
        })
        return {
          providerAccountId: account.id,
          requestId: input.requestId,
          status: 'QUEUED' as const,
        }
      }),
    ),
})
