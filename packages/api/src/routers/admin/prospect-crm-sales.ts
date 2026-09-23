import { TRPCError } from '@trpc/server'
import { db, ProspectSalesError, withTenantIsolationBypass } from '@pathfinder/db'
import { router } from '../../core'
import { adminProcedure } from '../../trpc'
import { getNativeSalesWorkflow, applyNativeSalesAction, readAuthenticatedSalesReadiness } from '../../prospect-sales-workflow'
import { salesReadInput, salesLocalAction } from '../../prospect-sales-contract'

function fail(error: unknown): never {
  if (error instanceof ProspectSalesError)
    throw new TRPCError({
      code:
        error.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : error.code === 'FORBIDDEN'
            ? 'FORBIDDEN'
            : error.code === 'INVALID_INPUT'
              ? 'BAD_REQUEST'
              : 'CONFLICT',
      message: error.message,
    })
  throw error
}

const companyMailbox = 'tomschoenekase@torchiko.com'
async function readCompanyMailboxStatus() {
  try {
    const accounts = await withTenantIsolationBypass(() =>
      db.correspondenceProviderAccount.findMany({
        where: { provider: 'GMAIL', mailboxAddress: { equals: companyMailbox, mode: 'insensitive' } },
        select: { id: true, mailboxAddress: true, connectionStatus: true,
          lastSuccessfulSyncAt: true, updatedAt: true },
        take: 2,
      }),
    )
    if (accounts.length === 0) return {
      identity: companyMailbox, state: 'unconfigured' as const,
      accountId: null, connectionStatus: null, lastSuccessfulSyncAt: null,
      updatedAt: null, syncEvidence: 'NO_SUCCESSFUL_SYNC_RECORDED' as const,
      queueState: 'NOT_INSPECTED' as const,
      nextAction: 'LOCATE_EXISTING_COMPANY_ACCOUNT' as const,
    }
    if (accounts.length !== 1) return {
      identity: companyMailbox, state: 'ambiguous' as const,
      accountId: null, connectionStatus: null, lastSuccessfulSyncAt: null,
      updatedAt: null, syncEvidence: 'NOT_ESTABLISHED' as const,
      queueState: 'NOT_INSPECTED' as const,
      nextAction: 'RESOLVE_COMPANY_ACCOUNT_IDENTITY' as const,
    }
    const account = accounts[0]!
    return {
      identity: companyMailbox, state: 'registered' as const,
      accountId: account.id, connectionStatus: account.connectionStatus,
      lastSuccessfulSyncAt: account.lastSuccessfulSyncAt?.toISOString() ?? null,
      updatedAt: account.updatedAt.toISOString(),
      syncEvidence: account.lastSuccessfulSyncAt
        ? 'LAST_SUCCESSFUL_SYNC_RECORDED' as const : 'NO_SUCCESSFUL_SYNC_RECORDED' as const,
      queueState: 'NOT_INSPECTED' as const,
      nextAction: account.connectionStatus === 'CONNECTED'
        ? account.lastSuccessfulSyncAt ? 'REVIEW_CURRENT_MAILBOX_SNAPSHOT' as const
          : 'REQUEST_EXISTING_ACCOUNT_RECONCILIATION' as const
        : 'REPAIR_EXISTING_COMPANY_ACCOUNT_CONNECTION' as const,
    }
  } catch {
    return {
      identity: companyMailbox, state: 'unavailable' as const,
      accountId: null, connectionStatus: null, lastSuccessfulSyncAt: null,
      updatedAt: null, syncEvidence: 'NOT_ESTABLISHED' as const,
      queueState: 'NOT_INSPECTED' as const,
      nextAction: 'RETRY_MAILBOX_STATUS_READ' as const,
    }
  }
}

/** Intentionally no approve/send/freeze/outbox/provider/authentication procedure. */
export const adminProspectCrmSalesRouter = router({
  getProspectSalesReadiness: adminProcedure.query(async () => {
    const [sales, mailbox] = await Promise.all([
      readAuthenticatedSalesReadiness(), readCompanyMailboxStatus(),
    ])
    return { ...sales, authentication: { scope: 'AUTHENTICATED_PLATFORM_ADMIN' as const },
      mailbox }
  }),
  getProspectSalesWorkflow: adminProcedure.input(salesReadInput).query(async ({ input }) => {
    try {
      return await getNativeSalesWorkflow(input.venueId, 'authenticated-admin')
    } catch (error) {
      fail(error)
    }
  }),
  prepareReviewProspectSales: adminProcedure
    .input(salesLocalAction)
    .mutation(async ({ input, ctx }) => {
      try {
        return await applyNativeSalesAction(input, {
          type: 'HUMAN',
          role: 'PLATFORM_ADMIN',
          id: ctx.session.userId,
        }, 'authenticated-admin')
      } catch (error) {
        fail(error)
      }
    }),
})
