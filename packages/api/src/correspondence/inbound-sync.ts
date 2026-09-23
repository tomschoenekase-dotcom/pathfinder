import { createHash } from 'node:crypto'

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

export class SyncCursorConflictError extends Error {
  constructor() {
    super('Correspondence cursor changed during synchronization; retry from the current checkpoint')
    this.name = 'SyncCursorConflictError'
  }
}

export type ReceiptRecord = ProviderReceiptIdentity &
  Readonly<{
    id: string
    state: ReceiptState
    receivedAt: Date
    attemptCount: number
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
  receiveReceipt(input: ProviderReceiptIdentity & {
    messageExternalId: string
    receivedAt: Date
  }): Promise<{
    receipt: ReceiptRecord
    inserted: boolean
  }>
  /** A bounded lease; a newer attempt supersedes an expired one. */
  claimReceipt(receiptId: string, claimedAt: Date): Promise<{
    receipt: ReceiptRecord
    claimed: boolean
  }>
  markReceiptState(input: {
    receiptId: string
    attemptCount: number
    state: ReceiptState
  }): Promise<{ receipt: ReceiptRecord; applied: boolean }>
  findThreadCandidates(message: NormalizedProviderMessage): Promise<readonly ThreadMatchCandidate[]>
  upsertCanonicalMessage(input: {
    canonicalThreadId: string
    message: NormalizedProviderMessage
    ingestedAt: Date
  }): Promise<{ canonicalMessageId: string; inserted: boolean }>
  appendRelationshipReply(input: {
    canonicalMessageId: string
    canonicalThreadId: string
    providerAccountId: string
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
    message: NormalizedProviderMessage | null
    candidateThreadIds?: readonly string[]
    occurredAt: Date
  }): Promise<void>
  getSyncCursor(mailbox: ProviderMailboxRef): Promise<string | null>
  commitSyncCursor(input: {
    mailbox: ProviderMailboxRef
    expectedCursor: string | null
    cursor: string
    mode: 'INCREMENTAL' | 'FULL_RECONCILIATION'
    completedAt: Date
  }): Promise<void>
  clearExpiredSyncCursor(input: {
    mailbox: ProviderMailboxRef
    expectedCursor: string
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

function receiptOutcome(receipt: ReceiptRecord) {
  return ['PROCESSED', 'QUARANTINED', 'PERMANENT_FAILURE'].includes(receipt.state)
    ? 'DUPLICATE' as const
    : 'IN_PROGRESS' as const
}

function receiptDurablyHandled(receipt: ReceiptRecord) {
  return ['PROCESSED', 'QUARANTINED', 'PERMANENT_FAILURE'].includes(receipt.state)
}

export function chooseThreadMatch(candidates: readonly ThreadMatchCandidate[]): ThreadMatch {
  if (candidates.length === 0) return { state: 'UNKNOWN', reason: 'No canonical thread matched' }
  const exactProvider = candidates.filter((candidate) =>
    candidate.evidence.includes('PROVIDER_THREAD'),
  )
  const exactRfc = candidates.filter((candidate) => candidate.evidence.includes('RFC_REFERENCE'))
  const strongIds = [...new Set([...exactProvider, ...exactRfc].map((c) => c.canonicalThreadId))]
  if (strongIds.length > 1)
    return {
      state: 'AMBIGUOUS',
      reason:
        'Provider thread and RFC evidence conflict; do not silently choose a different prospect',
      candidateThreadIds: strongIds.sort(),
    }
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
    if (message.direction === 'INBOUND') {
      await store.appendRelationshipReply({
        canonicalMessageId: persisted.canonicalMessageId,
        canonicalThreadId: match.candidate.canonicalThreadId,
        providerAccountId: message.message.providerAccountId,
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
    const claim = await store.claimReceipt(receipt.id, now())
    if (!claim.claimed) {
      return {
        state: receiptOutcome(claim.receipt),
        receipt: claim.receipt,
      }
    }
    const finish = async (state: 'PROCESSED' | 'QUARANTINED') =>
      store.markReceiptState({
        receiptId: receipt.id,
        attemptCount: claim.receipt.attemptCount,
        state,
      })
    try {
      if (!sameScope(mailbox, messageRef)) {
        await store.quarantine({
          receiptId: receipt.id,
          reason: 'INVALID_MESSAGE_SCOPE',
          message: null,
          occurredAt: now(),
        })
        const completed = await finish('QUARANTINED')
        return { state: completed.applied ? 'QUARANTINED' as const : receiptOutcome(completed.receipt),
          receipt: completed.receipt }
      }
      const message = await provider.retrieveMessage(mailbox, messageRef)
      if (
        !sameScope(mailbox, message.message) ||
        !sameScope(mailbox, message.thread) ||
        message.message.externalId !== messageRef.externalId
      ) {
        await store.quarantine({
          receiptId: receipt.id,
          reason: 'INVALID_MESSAGE_SCOPE',
          message: null,
          occurredAt: now(),
        })
        const completed = await finish('QUARANTINED')
        return { state: completed.applied ? 'QUARANTINED' as const : receiptOutcome(completed.receipt),
          receipt: completed.receipt }
      }
      const result = await ingestMessage(message, receipt.id)
      const completed = await finish(result.state === 'QUARANTINED' ? 'QUARANTINED' : 'PROCESSED')
      return {
        ...result,
        state: completed.applied ? result.state : receiptOutcome(completed.receipt),
        receipt: completed.receipt,
      }
    } catch (error) {
      if (error instanceof CorrespondenceProviderError && error.code === 'NOT_FOUND') {
        await store.quarantine({
          receiptId: receipt.id,
          reason: 'PROVIDER_MESSAGE_NOT_FOUND',
          message: null,
          occurredAt: now(),
        })
        const completed = await finish('QUARANTINED')
        return { state: completed.applied ? 'QUARANTINED' as const : receiptOutcome(completed.receipt),
          receipt: completed.receipt }
      }
      await store.markReceiptState({
        receiptId: receipt.id,
        attemptCount: claim.receipt.attemptCount,
        state: 'RETRYABLE_FAILURE',
      })
      throw error
    }
  }

  async function quarantineUnavailableMessage(
    mailbox: ProviderMailboxRef,
    message: ProviderExternalRef,
  ) {
    const received = await store.receiveReceipt({
      provider: mailbox.provider,
      providerAccountId: mailbox.providerAccountId,
      mailboxId: mailbox.mailboxId,
      // Stable across retries of the same provider history page and message.
      externalReceiptId: `history-message:${createHash('sha256').update(JSON.stringify([
        mailbox.provider,
        mailbox.providerAccountId,
        mailbox.mailboxId,
        message.externalId,
      ])).digest('hex').slice(0, 40)}`,
      messageExternalId: message.externalId,
      receivedAt: now(),
    })
    const claim = await store.claimReceipt(received.receipt.id, now())
    if (!claim.claimed) {
      if (receiptDurablyHandled(claim.receipt)) return
      throw new Error('Unavailable provider message is still being quarantined')
    }
    try {
      await store.quarantine({
        receiptId: received.receipt.id,
        reason: 'PROVIDER_MESSAGE_NOT_FOUND',
        message: null,
        occurredAt: now(),
      })
      const completed = await store.markReceiptState({
        receiptId: received.receipt.id,
        attemptCount: claim.receipt.attemptCount,
        state: 'QUARANTINED',
      })
      if (!completed.applied && !receiptDurablyHandled(completed.receipt)) {
        throw new Error('Unavailable provider message quarantine was superseded before completion')
      }
    } catch (error) {
      await store.markReceiptState({
        receiptId: received.receipt.id,
        attemptCount: claim.receipt.attemptCount,
        state: 'RETRYABLE_FAILURE',
      })
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
        messageExternalId: input.message.externalId,
        receivedAt: input.receivedAt ?? now(),
      })
      return processReceipt(received.receipt, input.mailbox, input.message)
    },

    async synchronize(mailbox: ProviderMailboxRef): Promise<{
      mode: 'INCREMENTAL' | 'FULL_RECONCILIATION'
      cursor: string
      processed: number
    }> {
      const cursor = await store.getSyncCursor(mailbox)
      const mode = cursor ? 'INCREMENTAL' : 'FULL_RECONCILIATION'
      let pageToken: string | undefined
      let reconciliationAnchor: string | undefined
      let finalCursor = cursor ?? ''
      let processed = 0
      const seenPageTokens = new Set<string>()
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
                ...(reconciliationAnchor ? { historyId: reconciliationAnchor } : {}),
                pageSize,
              })
          for (const unavailable of page.unavailableMessages ?? []) {
            if (!sameScope(mailbox, unavailable)) {
              await store.quarantine({
                receiptId: null,
                reason: 'INVALID_MESSAGE_SCOPE',
                message: null,
                occurredAt: now(),
              })
              continue
            }
            await quarantineUnavailableMessage(mailbox, unavailable)
          }
          for (const message of page.messages) {
            if (!sameScope(mailbox, message.message) || !sameScope(mailbox, message.thread)) {
              await store.quarantine({
                receiptId: null,
                reason: 'INVALID_MESSAGE_SCOPE',
                message,
                occurredAt: now(),
              })
              continue
            }
            await ingestMessage(message, null)
            processed += 1
          }
          if (!page.cursor || page.hasMore !== Boolean(page.nextPageToken)) {
            throw new Error('Provider returned an incomplete correspondence page')
          }
          if (page.nextPageToken) {
            if (seenPageTokens.has(page.nextPageToken)) {
              throw new Error('Provider repeated a correspondence page token')
            }
            seenPageTokens.add(page.nextPageToken)
          }
          finalCursor = page.cursor
          if (!cursor) reconciliationAnchor ??= page.cursor
          pageToken = page.hasMore ? (page.nextPageToken ?? undefined) : undefined
        } while (pageToken)

        // Cursor advances only after every returned page and message has been durably handled.
        await store.commitSyncCursor({
          mailbox,
          expectedCursor: cursor,
          cursor: finalCursor,
          mode,
          completedAt: now(),
        })
        await store.recordHealth({
          mailbox,
          operation: mode === 'INCREMENTAL' ? 'INCREMENTAL_SYNC' : 'RECONCILIATION',
          state: 'SUCCEEDED',
          occurredAt: now(),
        })
        return { mode, cursor: finalCursor, processed }
      } catch (error) {
        if (error instanceof SyncCursorConflictError) throw error
        if (
          cursor &&
          error instanceof CorrespondenceProviderError &&
          error.code === 'HISTORY_CURSOR_EXPIRED'
        ) {
          // A full sync is required, but only the run that observed this exact
          // cursor may clear it. Another run may already have moved it forward.
          await store.clearExpiredSyncCursor({ mailbox, expectedCursor: cursor })
          return this.synchronize(mailbox)
        }
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
