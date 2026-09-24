import { TRPCError } from '@trpc/server'
import { db, isIntendedNativeGmailAccount, writeAuditLogStrict } from '@pathfinder/db'
import { enqueueGmailSync } from '@pathfinder/jobs'

/** Existing-account action only. The admin router authenticates the operator;
 * queue acceptance is not successful Gmail synchronization or mailbox activation. */
export async function requestProspectMailboxReconciliation(input: {
  providerAccountId: string
  expectedUpdatedAt: string
  actorId: string
}) {
  if (!input.actorId.trim() || input.providerAccountId === '*')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'One existing account and an authenticated operator are required.',
    })
  const account = await db.correspondenceProviderAccount.findUnique({
    where: { id: input.providerAccountId },
    select: {
      id: true,
      provider: true,
      externalAccountId: true,
      mailboxAddress: true,
      credentialReferenceId: true,
      connectionStatus: true,
      capabilities: true,
      updatedAt: true,
    },
  })
  if (!account)
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Existing Gmail account not found.' })
  if (!isIntendedNativeGmailAccount(account))
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Select the confirmed tomschoenekase@torchiko.com account; no account or identity was changed.',
    })
  if (account.updatedAt.toISOString() !== input.expectedUpdatedAt)
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'The mailbox record changed. Reload its current status before reconciliation.',
    })
  if (
    !account.credentialReferenceId ||
    !['CONNECTED', 'DEGRADED'].includes(account.connectionStatus) ||
    !account.capabilities.includes('RECONCILE')
  )
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'Authenticate the existing company Gmail account through its existing OAuth owner first. Reconciliation cannot activate or reconnect a mailbox.',
    })
  await writeAuditLogStrict({
    actorId: input.actorId,
    actorRole: 'PLATFORM_ADMIN',
    actorType: 'HUMAN',
    action: 'prospect-mailbox.reconciliation-requested',
    targetType: 'CorrespondenceProviderAccount',
    targetId: account.id,
    structuredReason: {
      expectedUpdatedAt: input.expectedUpdatedAt,
      mailboxAddress: account.mailboxAddress,
      queueAcceptanceNotYetConfirmed: true,
      mailboxActivated: false,
      sendAuthorized: false,
    },
  })
  // Use the existing queue's account/trigger/time-window idempotency. No alternate
  // sync runner, cursor reset, worker spawn, sender or credential read is added.
  await enqueueGmailSync({ providerAccountId: account.id, trigger: 'SCHEDULED_RECONCILIATION' })
  return {
    providerAccountId: account.id,
    mailboxAddress: account.mailboxAddress,
    state: 'QUEUED_NOT_SYNCHRONIZED' as const,
    mailboxActivated: false,
    deliveryEnabledByThisAction: false,
    SEND_AUTHORIZED: false,
  }
}
