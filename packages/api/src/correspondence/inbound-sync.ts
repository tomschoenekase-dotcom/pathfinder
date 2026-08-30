import { normalizeUntrustedCorrespondenceBody } from './content-safety'
import type { CorrespondenceProvider } from './provider'
import type {
  NormalizedProviderMessage,
  ProviderExternalRef,
  ProviderMailboxRef,
  ProviderWatch,
} from './types'
import { CorrespondenceProviderError } from './types'

export type ProviderReceiptIdentity = Readonly<{
  provider: ProviderMailboxRef['provider']
  providerAccountId: string
  mailboxId: string
  externalReceiptId: string
}>

export type ReceiptState =
  | 'RECEIVED'
  | 'PROCESSING'
  | 'PROCESSED'
  | 'QUARANTINED'
  | 'RETRYABLE_FAILURE'
  | 'PERMANENT_FAILURE'

export type ReceiptRecord = ProviderReceiptIdentity &
  Readonly<{
    id: string
    state: ReceiptState
    receivedAt: Date
  }>

export type ThreadMatchCandidate = Readonly<{
  canonicalThreadId: string
  prospectOrganizationId: string
  contactId: string | null
  /** The one campaign membership related to this canonical conversation, if any. */
  campaignMemberId: string | null
  pendingFollowupIds: readonly string[]
  evidence: readonly ('PROVIDER_THREAD' | 'RFC_REFERENCE' | 'VERIFIED_PARTICIPANT')[]
}>

export type ThreadMatch =
  | Readonly<{ state: 'MATCHED'; candidate: ThreadMatchCandidate }>
  | Readonly<{ state: 'UNKNOWN'; reason: string }>
  | Readonly<{ state: 'AMBIGUOUS'; reason: string; candidateThreadIds: readonly string[] }>

export type InboundQuarantineReason =
  | 'UNKNOWN_THREAD'
  | 'AMBIGUOUS_THREAD'
  | 'PROVIDER_MESSAGE_NOT_FOUND'
  | 'INVALID_MESSAGE_SCOPE'
  | 'UNSAFE_OR_OVERSIZED_MESSAGE'

export type InboundCorrespondenceStore = Readonly<{
  /** Must commit before processing begins. Uniqueness is provider + account + mailbox + receipt ID. */
  receiveReceipt(input: ProviderReceiptIdentity & { receivedAt: Date }): Promise<{
    receipt: ReceiptRecord
    inserted: boolean
  }>
  markReceiptState(receiptId: string, state: ReceiptState, detail?: string): Promise<void>
  findThreadCandidates(message: NormalizedProviderMessage): Promise<readonly ThreadMatchCandidate[]>
  upsertCanonicalMessage(input: {
    canonicalThreadId: string
    message: NormalizedProviderMessage
    ingestedAt: Date
  }): Promise<{ canonicalMessageId: string; inserted: boolean }>
  appendRelationshipReply(input: {
    canonicalMessageId: string
    canonicalThreadId: string
    prospectOrganizationId: string
    contactId: string | null
    campaignMemberId: string | null
    occurredAt: Date
    matchingEvidence: ThreadMatchCandidate['evidence']
  }): Promise<void>
  holdFollowups(input: {
    followupIds: readonly string[]
    causedByCanonicalMessageId: string
    occurredAt: Date
  }): Promise<void>
  quarantine(input: {
    receiptId: string | null
    reason: InboundQuarantineReason
    detail: string
    message: NormalizedProviderMessage | null
    candidateThreadIds?: readonly string[]
    occurredAt: Date
  }): Promise<void>
  getSyncCursor(mailbox: ProviderMailboxRef): Promise<string | null>
  commitSyncCursor(input: {
    mailbox: ProviderMailboxRef
    cursor: string
    mode: 'INCREMENTAL' | 'FULL_RECONCILIATION'
    completedAt: Date
  }): Promise<void>
  saveWatch(input: {
    mailbox: ProviderMailboxRef
    watch: ProviderWatch
    renewedAt: Date
  }): Promise<void>
  recordHealth(input: {
    mailbox: ProviderMailboxRef
    operation: 'INCREMENTAL_SYNC' | 'RECONCILIATION' | 'WATCH_RENEWAL'
    state: 'SUCCEEDED' | 'FAILED'
    occurredAt: Date
  }): Promise<void>
}>

export type DeliveryState =
  | 'QUEUED'
  | 'SENT'
  | 'DELIVERED'
  | 'REPLIED'
  | 'SOFT_BOUNCED'
  | 'HARD_BOUNCED'
  | 'COMPLAINED'
  | 'UNSUBSCRIBED'

const DELIVERY_PRECEDENCE: Readonly<Record<DeliveryState, number>> = {
  QUEUED: 0,
  SENT: 10,
  DELIVERED: 20,
  SOFT_BOUNCED: 30,
  REPLIED: 40,
  HARD_BOUNCED: 50,
  COMPLAINED: 60,
  UNSUBSCRIBED: 70,
}

/** Arrival order is irrelevant: folding the same event set always produces the same projection. */
export function foldDeliveryState(events: readonly DeliveryState[]): DeliveryState | null {
  return events.reduce<DeliveryState | null>((current, event) => {
    if (!current || DELIVERY_PRECEDENCE[event] > DELIVERY_PRECEDENCE[current]) return event
    return current
  }, null)
}

function sameScope(mailbox: ProviderMailboxRef, ref: ProviderExternalRef) {
  return (
    ref.provider === mailbox.provider &&
    ref.providerAccountId === mailbox.providerAccountId &&
    ref.mailboxId === mailbox.mailboxId
  )
}

export function chooseThreadMatch(candidates: readonly ThreadMatchCandidate[]): ThreadMatch {
  if (candidates.length === 0) return { state: 'UNKNOWN', reason: 'No canonical thread matched' }
  const exactProvider = candidates.filter((candidate) =>
    candidate.evidence.includes('PROVIDER_THREAD'),
  )
  const exactRfc = candidates.filter((candidate) => candidate.evidence.includes('RFC_REFERENCE'))
  const strongest =
    exactProvider.length > 0 ? exactProvider : exactRfc.length > 0 ? exactRfc : candidates
  const byThread = new Map(strongest.map((candidate) => [candidate.canonicalThreadId, candidate]))
  if (byThread.size !== 1) {
    return {
      state: 'AMBIGUOUS',
      reason: 'Matching evidence points to multiple canonical threads',
      candidateThreadIds: [...byThread.keys()].sort(),
    }
  }
  return { state: 'MATCHED', candidate: [...byThread.values()][0]! }
}

function normalizedForPersistence(message: NormalizedProviderMessage): NormalizedProviderMessage {
  return {
    ...message,
    subject: message.subject.slice(0, 998),
    body: normalizeUntrustedCorrespondenceBody({
      text: message.body.text,
      html: message.body.html,
    }),
    attachments: message.attachments.slice(0, 50).map((attachment) => ({
      ...attachment,
      filename: attachment.filename.slice(0, 255),
      mimeType: attachment.mimeType.slice(0, 255),
      sizeBytes: Math.max(0, Math.min(attachment.sizeBytes, 2_147_483_647)),
      downloadPolicy: 'METADATA_ONLY' as const,
    })),
  }
}

export function createInboundCorrespondenceService(input: {
  provider: CorrespondenceProvider
  store: InboundCorrespondenceStore
  now?: () => Date
  pageSize?: number
}) {
  const { provider, store } = input
  const now = input.now ?? (() => new Date())
  const pageSize = input.pageSize ?? 100

  async function ingestMessage(messageInput: NormalizedProviderMessage, receiptId: string | null) {
    const message = normalizedForPersistence(messageInput)
    const candidates = await store.findThreadCandidates(message)
    const match = chooseThreadMatch(candidates)
    if (match.state !== 'MATCHED') {
      await store.quarantine({
        receiptId,
        reason: match.state === 'UNKNOWN' ? 'UNKNOWN_THREAD' : 'AMBIGUOUS_THREAD',
        detail: match.reason,
        message,
        ...(match.state === 'AMBIGUOUS' ? { candidateThreadIds: match.candidateThreadIds } : {}),
        occurredAt: now(),
      })
      return { state: 'QUARANTINED' as const, match }
    }

    const persisted = await store.upsertCanonicalMessage({
      canonicalThreadId: match.candidate.canonicalThreadId,
      message,
      ingestedAt: now(),
    })
    if (persisted.inserted && message.direction === 'INBOUND') {
      await store.appendRelationshipReply({
        canonicalMessageId: persisted.canonicalMessageId,
        canonicalThreadId: match.candidate.canonicalThreadId,
        prospectOrganizationId: match.candidate.prospectOrganizationId,
        contactId: match.candidate.contactId,
        campaignMemberId: match.candidate.campaignMemberId,
        occurredAt: message.internalDate,
        matchingEvidence: match.candidate.evidence,
      })
      await store.holdFollowups({
        followupIds: match.candidate.pendingFollowupIds,
        causedByCanonicalMessageId: persisted.canonicalMessageId,
        occurredAt: message.internalDate,
      })
    }
    return { state: 'PROCESSED' as const, inserted: persisted.inserted }
  }

  async function processReceipt(
    receipt: ReceiptRecord,
    mailbox: ProviderMailboxRef,
    messageRef: ProviderExternalRef,
  ) {
    if (!sameScope(mailbox, messageRef)) {
      await store.quarantine({
        receiptId: receipt.id,
        reason: 'INVALID_MESSAGE_SCOPE',
        detail: 'Notification message reference is outside the receipt mailbox scope',
        message: null,
        occurredAt: now(),
      })
      await store.markReceiptState(receipt.id, 'QUARANTINED')
      return { state: 'QUARANTINED' as const }
    }
    await store.markReceiptState(receipt.id, 'PROCESSING')
    try {
      const message = await provider.retrieveMessage(mailbox, messageRef)
      const result = await ingestMessage(message, receipt.id)
      await store.markReceiptState(
        receipt.id,
        result.state === 'QUARANTINED' ? 'QUARANTINED' : 'PROCESSED',
      )
      return result
    } catch (error) {
      if (error instanceof CorrespondenceProviderError && error.code === 'NOT_FOUND') {
        const detail = 'Provider message was not available for retrieval.'
        await store.quarantine({
          receiptId: receipt.id,
          reason: 'PROVIDER_MESSAGE_NOT_FOUND',
          detail,
          message: null,
          occurredAt: now(),
        })
        await store.markReceiptState(receipt.id, 'QUARANTINED', detail)
        return { state: 'QUARANTINED' as const }
      }
      await store.markReceiptState(
        receipt.id,
        'RETRYABLE_FAILURE',
        'Provider message retrieval failed before canonical ingestion.',
      )
      throw error
    }
  }

  return {
    async receiveNotification(input: {
      mailbox: ProviderMailboxRef
      externalReceiptId: string
      message: ProviderExternalRef
      receivedAt?: Date
    }) {
      // This await is deliberately before provider access: the receipt is durable first.
      const received = await store.receiveReceipt({
        provider: input.mailbox.provider,
        providerAccountId: input.mailbox.providerAccountId,
        mailboxId: input.mailbox.mailboxId,
        externalReceiptId: input.externalReceiptId,
        receivedAt: input.receivedAt ?? now(),
      })
      if (!received.inserted && ['PROCESSED', 'QUARANTINED'].includes(received.receipt.state)) {
        return { state: 'DUPLICATE' as const, receipt: received.receipt }
      }
      const result = await processReceipt(received.receipt, input.mailbox, input.message)
      return { ...result, receipt: received.receipt }
    },

    async synchronize(mailbox: ProviderMailboxRef) {
      const cursor = await store.getSyncCursor(mailbox)
      const mode = cursor ? 'INCREMENTAL' : 'FULL_RECONCILIATION'
      let pageToken: string | undefined
      let finalCursor = cursor ?? ''
      let processed = 0
      try {
        do {
          const page = cursor
            ? await provider.syncIncremental({
                mailbox,
                cursor,
                ...(pageToken ? { pageToken } : {}),
                pageSize,
              })
            : await provider.reconcile({
                mailbox,
                after: new Date(0),
                ...(pageToken ? { pageToken } : {}),
                pageSize,
              })
          for (const message of page.messages) {
            if (!sameScope(mailbox, message.message) || !sameScope(mailbox, message.thread)) {
              await store.quarantine({
                receiptId: null,
                reason: 'INVALID_MESSAGE_SCOPE',
                detail: 'Sync returned a message outside the requested mailbox scope',
                message,
                occurredAt: now(),
              })
              continue
            }
            await ingestMessage(message, null)
            processed += 1
          }
          finalCursor = page.cursor
          pageToken = page.hasMore ? (page.nextPageToken ?? undefined) : undefined
        } while (pageToken)

        // Cursor advances only after every returned page and message has been durably handled.
        await store.commitSyncCursor({ mailbox, cursor: finalCursor, mode, completedAt: now() })
        await store.recordHealth({
          mailbox,
          operation: mode === 'INCREMENTAL' ? 'INCREMENTAL_SYNC' : 'RECONCILIATION',
          state: 'SUCCEEDED',
          occurredAt: now(),
        })
        return { mode, cursor: finalCursor, processed }
      } catch (error) {
        await store.recordHealth({
          mailbox,
          operation: mode === 'INCREMENTAL' ? 'INCREMENTAL_SYNC' : 'RECONCILIATION',
          state: 'FAILED',
          occurredAt: now(),
        })
        throw error
      }
    },

    async renewWatch(mailbox: ProviderMailboxRef, topicName: string) {
      try {
        const watch = await provider.renewWatch({ mailbox, topicName })
        await store.saveWatch({ mailbox, watch, renewedAt: now() })
        await store.recordHealth({
          mailbox,
          operation: 'WATCH_RENEWAL',
          state: 'SUCCEEDED',
          occurredAt: now(),
        })
        return watch
      } catch (error) {
        await store.recordHealth({
          mailbox,
          operation: 'WATCH_RENEWAL',
          state: 'FAILED',
          occurredAt: now(),
        })
        throw error
      }
    },
  }
}
