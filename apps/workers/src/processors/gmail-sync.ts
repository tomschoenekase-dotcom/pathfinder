import {
  CorrespondenceProviderError,
  createGmailApiClient,
  createGmailCorrespondenceProvider,
  createGmailOAuthRuntime,
  createInboundCorrespondenceService,
  createPrismaInboundCorrespondenceStore,
  type ProviderMailboxRef,
} from '@pathfinder/api/correspondence'
import { db, publishCrmOperationalSignal, withTenantIsolationBypass } from '@pathfinder/db'
import type { GmailSyncJobPayload } from '@pathfinder/jobs'

function configuration() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const redirectUri = process.env.GMAIL_OAUTH_REDIRECT_URI
  const integrationEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
  if (!clientId || !clientSecret || !redirectUri || !integrationEncryptionKey) {
    throw new Error('Gmail OAuth runtime is not configured')
  }
  return { clientId, clientSecret, redirectUri, integrationEncryptionKey }
}

async function mailboxFor(providerAccountId: string): Promise<ProviderMailboxRef> {
  const account = await withTenantIsolationBypass(() =>
    db.correspondenceProviderAccount.findUnique({ where: { id: providerAccountId } }),
  )
  if (!account || account.provider !== 'GMAIL' || !account.credentialReferenceId) {
    throw new Error('Connected Gmail provider account was not found')
  }
  if (account.connectionStatus === 'DISCONNECTED') {
    throw new Error('Gmail provider account is disconnected')
  }
  return {
    provider: 'GMAIL',
    providerAccountId: account.id,
    mailboxId: account.externalAccountId,
    mailboxAddress: account.mailboxAddress,
    credentialRef: account.credentialReferenceId,
  }
}

async function markNotificationReceipt(receiptId: string, success: boolean, detail?: string) {
  await withTenantIsolationBypass(() =>
    db.prospectEmailWebhookReceipt.updateMany({
      where: { id: receiptId },
      data: {
        status: success ? 'PROCESSED' : 'RETRYABLE',
        attemptCount: { increment: 1 },
        ...(success ? { processedAt: new Date(), processingError: null } : {}),
        ...(!success && detail ? { processingError: detail.slice(0, 2_000) } : {}),
      },
    }),
  )
}

export async function processGmailSyncJob(payload: GmailSyncJobPayload) {
  if (payload.providerAccountId === '*') {
    if (payload.trigger === 'PUBSUB_NOTIFICATION') {
      throw new Error('A Pub/Sub notification must target one exact Gmail account')
    }
    const accounts = await withTenantIsolationBypass(() =>
      db.correspondenceProviderAccount.findMany({
        where: { provider: 'GMAIL', connectionStatus: { in: ['CONNECTED', 'DEGRADED'] } },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    )
    for (const account of accounts) {
      await processGmailSyncJob({ providerAccountId: account.id, trigger: payload.trigger })
    }
    return { accountsProcessed: accounts.length }
  }
  const mailbox = await mailboxFor(payload.providerAccountId)
  const runtime = createGmailOAuthRuntime({ configuration: configuration() })
  const provider = createGmailCorrespondenceProvider({
    credentials: runtime.credentials,
    client: createGmailApiClient(),
  })
  const service = createInboundCorrespondenceService({
    provider,
    store: createPrismaInboundCorrespondenceStore(),
  })

  try {
    if (payload.trigger === 'WATCH_RENEWAL') {
      const topic = process.env.GMAIL_PUBSUB_TOPIC
      if (!topic) throw new Error('GMAIL_PUBSUB_TOPIC is not configured')
      return await service.renewWatch(mailbox, topic)
    }

    try {
      const result = await service.synchronize(mailbox)
      if (payload.receiptId) await markNotificationReceipt(payload.receiptId, true)
      return result
    } catch (error) {
      if (
        !(error instanceof CorrespondenceProviderError) ||
        error.code !== 'HISTORY_CURSOR_EXPIRED'
      ) {
        throw error
      }
      // A stale Gmail history cursor is recoverable. Clearing it deliberately switches the
      // service to its bounded full-reconciliation path; push delivery remains only a hint.
      await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.update({
          where: { id: payload.providerAccountId },
          data: { syncCursor: null },
        }),
      )
      const result = await service.synchronize(mailbox)
      if (payload.receiptId) await markNotificationReceipt(payload.receiptId, true)
      return result
    }
  } catch (error) {
    const errorCode =
      error instanceof CorrespondenceProviderError ? error.code : 'GMAIL_SYNC_FAILED'
    if (payload.receiptId) await markNotificationReceipt(payload.receiptId, false, errorCode)
    await publishCrmOperationalSignal({
      input: {
        signal: 'gmail_sync_failed',
        scope: { kind: 'platform' },
        linkedObjectType: 'CorrespondenceProviderAccount',
        linkedObjectId: payload.providerAccountId,
        summary: `Gmail synchronization failed (${errorCode}).`,
      },
    })
    throw error
  }
}
