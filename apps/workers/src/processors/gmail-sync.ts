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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

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

async function markNotificationReceipt(receiptId: string, success: boolean) {
  await withTenantIsolationBypass(() =>
    db.prospectEmailWebhookReceipt.updateMany({
      where: { id: receiptId },
      data: {
        status: success ? 'PROCESSED' : 'RETRYABLE',
        attemptCount: { increment: 1 },
        ...(success ? { processedAt: new Date(), processingError: null } : {}),
        ...(!success ? { processingError: 'Gmail synchronization failed.' } : {}),
      },
    }),
  )
}

export async function processGmailSyncJob(payload: GmailSyncJobPayload) {
  if (
    payload.trigger === 'FULL_RECONCILIATION' &&
    (payload.providerAccountId === '*' ||
      payload.providerAccountId.trim() !== payload.providerAccountId ||
      !payload.requestId ||
      !UUID_PATTERN.test(payload.requestId))
  ) {
    throw new Error('Full Gmail reconciliation requires one exact account and request identity')
  }
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
      await processGmailSyncJob({ ...payload, providerAccountId: account.id })
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
      const result =
        payload.trigger === 'FULL_RECONCILIATION'
          ? await service.synchronize(mailbox, { fullReconciliation: true })
          : await service.synchronize(mailbox)
      if (payload.receiptId) await markNotificationReceipt(payload.receiptId, true)
      return result
    } catch (error) {
      if (
        !(error instanceof CorrespondenceProviderError) ||
        error.code !== 'HISTORY_CURSOR_EXPIRED' ||
        payload.trigger === 'FULL_RECONCILIATION'
      ) {
        throw error
      }
      // Keep the durable cursor until the full reconciliation finishes and commits its replacement.
      const result = await service.synchronize(mailbox, { fullReconciliation: true })
      if (payload.receiptId) await markNotificationReceipt(payload.receiptId, true)
      return result
    }
  } catch (error) {
    const errorCode =
      error instanceof CorrespondenceProviderError ? error.code : 'GMAIL_SYNC_FAILED'
    if (payload.receiptId) await markNotificationReceipt(payload.receiptId, false)
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
