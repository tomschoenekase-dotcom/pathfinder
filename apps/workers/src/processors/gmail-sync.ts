import {
  CorrespondenceProviderError,
  createClientReplyLinker,
  createGmailApiClient,
  createGmailCorrespondenceProvider,
  createGmailOAuthRuntime,
  createInboundCorrespondenceService,
  createPrismaInboundCorrespondenceStore,
  type ProviderMailboxRef,
} from '@pathfinder/api/correspondence'
import {
  db,
  publishCrmOperationalSignal,
  updateJobRecord,
  withTenantIsolationBypass,
  writeJobRecord,
} from '@pathfinder/db'
import { enqueueGmailSync, GMAIL_SYNC_QUEUE, type GmailSyncJobPayload } from '@pathfinder/jobs'

import {
  normalizeJobExecutionMetadata,
  recordJobFailure,
  type JobExecutionInput,
} from '../lib/job-execution'

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

async function mailboxFor(
  providerAccountId: string,
): Promise<ProviderMailboxRef & { lastReconciliationAt: Date | null }> {
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
    lastReconciliationAt: account.lastReconciliationAt,
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

async function synchronizeGmail(payload: GmailSyncJobPayload) {
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
  const after = payload.after
    ? new Date(payload.after)
    : payload.trigger === 'SCHEDULED_RECONCILIATION' &&
        !payload.requestId &&
        mailbox.lastReconciliationAt
      ? new Date(Math.max(0, mailbox.lastReconciliationAt.getTime() - 86_400_000))
      : new Date(0)
  if (!Number.isFinite(after.getTime())) throw new Error('Invalid Gmail reconciliation boundary')
  const runtime = createGmailOAuthRuntime({ configuration: configuration() })
  const provider = createGmailCorrespondenceProvider({
    credentials: runtime.credentials,
    client: createGmailApiClient(),
  })
  const service = createInboundCorrespondenceService({
    provider,
    store: createPrismaInboundCorrespondenceStore(),
    // Passive second matcher: a message no prospect thread claims may answer a client
    // notification. It links by platform-minted identifiers only and sends nothing.
    clientReplyLinker: createClientReplyLinker({ quarantineUnknown: false }),
  })

  try {
    if (payload.trigger === 'WATCH_RENEWAL') {
      const topic = process.env.GMAIL_PUBSUB_TOPIC
      if (!topic) throw new Error('GMAIL_PUBSUB_TOPIC is not configured')
      return await service.renewWatch(mailbox, topic)
    }

    try {
      const result = await service.synchronize(mailbox, {
        ...(payload.mode
          ? { mode: payload.mode }
          : payload.trigger === 'SCHEDULED_RECONCILIATION'
            ? { mode: 'FULL_RECONCILIATION' as const }
            : {}),
        ...(payload.trigger === 'SCHEDULED_RECONCILIATION' ? { after } : {}),
        ...(payload.pageToken ? { pageToken: payload.pageToken } : {}),
        ...(payload.baselineCursor !== undefined ? { baselineCursor: payload.baselineCursor } : {}),
        ...(payload.targetCursor ? { targetCursor: payload.targetCursor } : {}),
      })
      if (!result.complete) {
        if (!result.nextPageToken) throw new Error('Gmail continuation token is missing')
        const nextJobId = await enqueueGmailSync({
          ...payload,
          pageToken: result.nextPageToken,
          after: after.toISOString(),
          baselineCursor: result.baselineCursor,
          mode: result.mode,
          targetCursor: result.targetCursor,
        })
        return { ...result, nextJobId }
      }
      if (payload.receiptId) {
        await markNotificationReceipt(payload.receiptId, true)
      }
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
      const result = await service.synchronize(mailbox, {
        mode: 'FULL_RECONCILIATION',
        after: new Date(0),
      })
      if (!result.complete) {
        if (!result.nextPageToken) throw new Error('Gmail continuation token is missing')
        const nextJobId = await enqueueGmailSync({
          ...payload,
          trigger: 'SCHEDULED_RECONCILIATION',
          pageToken: result.nextPageToken,
          after: new Date(0).toISOString(),
          baselineCursor: result.baselineCursor,
          mode: result.mode,
          targetCursor: result.targetCursor,
        })
        return { ...result, nextJobId }
      }
      if (payload.receiptId) {
        await markNotificationReceipt(payload.receiptId, true)
      }
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

export async function processGmailSyncJob(
  payload: GmailSyncJobPayload,
  jobExecution?: JobExecutionInput,
) {
  const execution = normalizeJobExecutionMetadata(jobExecution)
  const jobRecordId = execution.bullJobId
    ? await writeJobRecord({
        queue: GMAIL_SYNC_QUEUE,
        jobName: payload.trigger,
        bullJobId: execution.bullJobId,
        status: 'RUNNING',
        startedAt: new Date(),
        attemptNumber: execution.attemptNumber,
        maxAttempts: execution.maxAttempts,
        payload: { providerAccountId: payload.providerAccountId, trigger: payload.trigger },
      })
    : null
  try {
    const result = await synchronizeGmail(payload)
    if (jobRecordId) {
      await withTenantIsolationBypass(() =>
        db.jobRecord.update({
          where: { id: jobRecordId },
          data: {
            payload: {
              providerAccountId: payload.providerAccountId,
              trigger: payload.trigger,
              processed: 'processed' in result ? result.processed : 0,
              complete: 'complete' in result ? result.complete : true,
              nextJobId: 'nextJobId' in result ? result.nextJobId : null,
              accountsProcessed: 'accountsProcessed' in result ? result.accountsProcessed : 1,
            },
          },
        }),
      )
      await updateJobRecord(jobRecordId, { status: 'COMPLETE' })
    }
    return result
  } catch (error) {
    if (jobRecordId) await recordJobFailure({ jobRecordId, error, execution })
    throw error
  }
}
