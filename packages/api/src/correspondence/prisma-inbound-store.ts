import { createHash } from 'node:crypto'

import {
  db,
  publishCrmOperationalSignal,
  recordProspectInboundReplyAction,
  withTenantIsolationBypass,
} from '@pathfinder/db'
import { ProspectCampaignMemberStatus } from '@prisma/client'

import type {
  InboundCorrespondenceStore,
  InboundQuarantineReason,
  ReceiptState,
  ThreadMatchCandidate,
} from './inbound-sync'
import { SyncCursorConflictError as CursorConflict } from './inbound-sync'
import { projectGmailBodyForPersistence, type GmailBodyPersistencePolicy } from './body-retention'

const receiptStatus: Record<
  ReceiptState,
  'RECEIVED' | 'PROCESSING' | 'PROCESSED' | 'QUARANTINED' | 'RETRYABLE' | 'PERMANENTLY_FAILED'
> = {
  RECEIVED: 'RECEIVED',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  QUARANTINED: 'QUARANTINED',
  RETRYABLE_FAILURE: 'RETRYABLE',
  PERMANENT_FAILURE: 'PERMANENTLY_FAILED',
}

function isUniqueConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')
}

function canonicalReceiptState(
  status:
    | 'RECEIVED'
    | 'PROCESSING'
    | 'PROCESSED'
    | 'QUARANTINED'
    | 'RETRYABLE'
    | 'PERMANENTLY_FAILED',
): ReceiptState {
  if (status === 'RETRYABLE') return 'RETRYABLE_FAILURE'
  if (status === 'PERMANENTLY_FAILED') return 'PERMANENT_FAILURE'
  return status
}

function boundMessageId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as Record<string, unknown>).messageExternalId
  return typeof value === 'string' && value.length > 0 ? value : null
}

function receiptRecord(row: {
  id: string
  provider: string
  providerAccountId: string | null
  providerMailboxKey: string
  providerEventId: string
  status: Parameters<typeof canonicalReceiptState>[0]
  createdAt: Date
  attemptCount: number
}) {
  if (!row.providerAccountId) throw new Error('Provider receipt has no account identity')
  return {
    id: row.id,
    provider: row.provider as 'GMAIL' | 'FAKE',
    providerAccountId: row.providerAccountId,
    mailboxId: row.providerMailboxKey,
    externalReceiptId: row.providerEventId,
    state: canonicalReceiptState(row.status),
    receivedAt: row.createdAt,
    attemptCount: row.attemptCount,
  }
}

function healthFailureSummary(operation: 'INCREMENTAL_SYNC' | 'RECONCILIATION' | 'WATCH_RENEWAL') {
  if (operation === 'INCREMENTAL_SYNC') return 'Correspondence incremental synchronization failed.'
  if (operation === 'RECONCILIATION') return 'Correspondence reconciliation failed.'
  return 'Correspondence watch renewal failed.'
}

function quarantineDetail(reason: InboundQuarantineReason) {
  if (reason === 'UNKNOWN_THREAD') return 'No canonical thread matched the inbound message.'
  if (reason === 'AMBIGUOUS_THREAD') {
    return 'Multiple canonical threads matched the inbound message.'
  }
  if (reason === 'PROVIDER_MESSAGE_NOT_FOUND') {
    return 'Provider message was not available for retrieval.'
  }
  if (reason === 'INVALID_MESSAGE_SCOPE') {
    return 'Inbound correspondence failed mailbox scope validation.'
  }
  return 'Inbound correspondence exceeded its safe persistence boundary.'
}

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

function candidateFromThread(
  thread: {
    id: string
    organizationId: string
    contactId: string | null
    organization: {
      campaignMembers: readonly { id: string; contactId: string | null }[]
      followups: readonly { id: string }[]
    }
  },
  evidence: ThreadMatchCandidate['evidence'],
): ThreadMatchCandidate {
  const member = thread.organization.campaignMembers.find(
    (item) => item.contactId === thread.contactId,
  )
  return {
    canonicalThreadId: thread.id,
    prospectOrganizationId: thread.organizationId,
    contactId: thread.contactId,
    campaignMemberId: member?.id ?? null,
    pendingFollowupIds: thread.organization.followups.map((item) => item.id),
    evidence,
  }
}

export function createPrismaInboundCorrespondenceStore(
  options: {
    bodyPersistence?: GmailBodyPersistencePolicy
  } = {},
): InboundCorrespondenceStore {
  const bodyPersistence = options.bodyPersistence ?? { mode: 'SOURCE_ONLY' as const }
  return {
    async receiveReceipt(input) {
      return withTenantIsolationBypass(async () => {
        if (!input.messageExternalId || input.messageExternalId.length > 191) {
          throw new Error('Provider receipt requires one exact message ID')
        }
        const account = await db.correspondenceProviderAccount.findUnique({
          where: { id: input.providerAccountId },
          select: { id: true, provider: true, externalAccountId: true },
        })
        if (!account) throw new Error('Provider account does not exist')
        if (account.provider !== input.provider || account.externalAccountId !== input.mailboxId)
          throw new Error('Provider receipt account/mailbox mismatch')
        const existing = await db.prospectEmailWebhookReceipt.findUnique({
          where: {
            provider_providerMailboxKey_providerEventId: {
              provider: input.provider,
              providerMailboxKey: input.mailboxId,
              providerEventId: input.externalReceiptId,
            },
          },
        })
        if (existing) {
          if (existing.providerAccountId !== input.providerAccountId)
            throw new Error('Existing provider receipt belongs to another account')
          if (boundMessageId(existing.payload) !== input.messageExternalId)
            throw new Error('Provider receipt event ID conflicts with its exact message reference')
          return {
            inserted: false,
            receipt: receiptRecord(existing),
          }
        }
        let receipt: { id: string }
        try {
          receipt = await db.prospectEmailWebhookReceipt.create({
            data: {
              provider: input.provider,
              providerAccountId: input.providerAccountId,
              providerMailboxKey: input.mailboxId,
              providerEventId: input.externalReceiptId,
              eventType: 'provider.message.notification',
              payload: { mailboxId: input.mailboxId, messageExternalId: input.messageExternalId },
              createdAt: input.receivedAt,
            },
          })
        } catch (error) {
          if (!isUniqueConflict(error)) throw error
          const raced = await db.prospectEmailWebhookReceipt.findUnique({
            where: {
              provider_providerMailboxKey_providerEventId: {
                provider: input.provider,
                providerMailboxKey: input.mailboxId,
                providerEventId: input.externalReceiptId,
              },
            },
          })
          if (!raced || raced.providerAccountId !== input.providerAccountId) throw error
          if (boundMessageId(raced.payload) !== input.messageExternalId)
            throw new Error('Provider receipt event ID conflicts with its exact message reference')
          return {
            inserted: false,
            receipt: receiptRecord(raced),
          }
        }
        return {
          inserted: true,
          receipt: {
            id: receipt.id,
            provider: input.provider,
            providerAccountId: input.providerAccountId,
            mailboxId: input.mailboxId,
            externalReceiptId: input.externalReceiptId,
            state: 'RECEIVED' as const,
            receivedAt: input.receivedAt,
            attemptCount: 0,
          },
        }
      })
    },
    async claimReceipt(receiptId, claimedAt) {
      const leaseUntil = new Date(claimedAt.getTime() + 5 * 60_000)
      const result = await withTenantIsolationBypass(() =>
        db.prospectEmailWebhookReceipt.updateMany({
          where: {
            id: receiptId,
            OR: [
              { status: { in: ['RECEIVED', 'RETRYABLE'] } },
              { status: 'PROCESSING', OR: [
                { nextAttemptAt: null },
                { nextAttemptAt: { lte: claimedAt } },
              ] },
            ],
          },
          data: {
            status: 'PROCESSING',
            attemptCount: { increment: 1 },
            nextAttemptAt: leaseUntil,
            processingError: null,
          },
        }),
      )
      const row = await withTenantIsolationBypass(() =>
        db.prospectEmailWebhookReceipt.findUniqueOrThrow({ where: { id: receiptId } }),
      )
      return {
        receipt: receiptRecord(row),
        claimed: result.count === 1 && row.status === 'PROCESSING' &&
          row.nextAttemptAt?.getTime() === leaseUntil.getTime(),
      }
    },
    async markReceiptState(input) {
      if (input.state === 'PROCESSING' || input.state === 'RECEIVED')
        throw new Error('Receipt finalization requires a result state')
      const result = await withTenantIsolationBypass(() =>
        db.prospectEmailWebhookReceipt.updateMany({
          where: {
            id: input.receiptId,
            status: 'PROCESSING',
            attemptCount: input.attemptCount,
          },
          data: {
            status: receiptStatus[input.state],
            nextAttemptAt: null,
            processingError: input.state === 'RETRYABLE_FAILURE'
              ? 'Provider message retrieval or canonical ingestion failed.'
              : null,
            ...(['PROCESSED', 'QUARANTINED', 'PERMANENT_FAILURE'].includes(input.state)
              ? { processedAt: new Date() }
              : {}),
          },
        }),
      )
      const row = await withTenantIsolationBypass(() =>
        db.prospectEmailWebhookReceipt.findUniqueOrThrow({ where: { id: input.receiptId } }),
      )
      return { receipt: receiptRecord(row), applied: result.count === 1 }
    },
    async findThreadCandidates(message) {
      return withTenantIsolationBypass(async () => {
        const include = {
          organization: {
            select: {
              campaignMembers: {
                where: {
                  status: {
                    in: [ProspectCampaignMemberStatus.QUEUED, ProspectCampaignMemberStatus.SENT],
                  },
                },
                orderBy: { createdAt: 'desc' as const },
                take: 5,
                select: { id: true, contactId: true },
              },
              followups: {
                where: { status: 'PENDING' as const },
                select: { id: true },
              },
            },
          },
        }
        const provider = await db.prospectEmailThreadProvider.findUnique({
          where: {
            providerAccountId_providerThreadId: {
              providerAccountId: message.thread.providerAccountId,
              providerThreadId: message.thread.externalId,
            },
          },
          include: { thread: { include } },
        })
        const references = [message.rfcMessageId, message.inReplyTo, ...message.references].filter(
          (item): item is string => Boolean(item),
        )
        const referenced = references.length
          ? await db.prospectEmailMessage.findMany({
              where: {
                internetMessageId: { in: references },
                providerAccountId: message.message.providerAccountId,
              },
              select: { thread: { include } },
              take: 20,
            })
          : []
        const participantEmails = [...message.from, ...message.to]
          .map((item) => item.email.toLowerCase())
          .slice(0, 20)
        const participantThreads = participantEmails.length
          ? await db.prospectEmailThread.findMany({
              where: {
                contact: { normalizedEmail: { in: participantEmails }, emailReadiness: 'VALID' },
                providerMappings: {
                  some: { providerAccountId: message.message.providerAccountId },
                },
              },
              include,
              take: 20,
            })
          : []
        const candidates = new Map<string, ThreadMatchCandidate>()
        const add = (
          thread: Parameters<typeof candidateFromThread>[0],
          evidence: ThreadMatchCandidate['evidence'][number],
        ) => {
          const current = candidates.get(thread.id)
          const evidenceSet = new Set([...(current?.evidence ?? []), evidence])
          candidates.set(thread.id, candidateFromThread(thread, [...evidenceSet]))
        }
        if (provider) add(provider.thread, 'PROVIDER_THREAD')
        for (const row of referenced) add(row.thread, 'RFC_REFERENCE')
        for (const thread of participantThreads) add(thread, 'VERIFIED_PARTICIPANT')
        return [...candidates.values()]
      })
    },
    async upsertCanonicalMessage(input) {
      return withTenantIsolationBypass(async () => {
        const thread = await db.prospectEmailThread.findUniqueOrThrow({
          where: { id: input.canonicalThreadId },
        })
        const existing = await db.prospectEmailMessage.findUnique({
          where: {
            providerAccountId_providerMessageId: {
              providerAccountId: input.message.message.providerAccountId,
              providerMessageId: input.message.message.externalId,
            },
          },
          select: {
            id: true,
            threadId: true,
            providerAccountId: true,
            internetMessageId: true,
            fromAddress: true,
            subject: true,
            textBody: true,
          },
        })
        if (existing) {
          if (
            existing.threadId !== thread.id ||
            existing.providerAccountId !== input.message.message.providerAccountId ||
            existing.internetMessageId !== input.message.rfcMessageId ||
            existing.fromAddress !== input.message.from[0]?.email ||
            existing.subject !== input.message.subject ||
            (existing.textBody !== null && existing.textBody !== input.message.body.text)
          )
            throw new Error('Conflicting provider message replay; canonical history is retained')
          return { canonicalMessageId: existing.id, inserted: false }
        }
        const bodyProjection = projectGmailBodyForPersistence({
          message: input.message,
          ingestedAt: input.ingestedAt,
          policy: bodyPersistence,
        })
        const created = await db.$transaction(async (tx) => {
          const mapping = await tx.prospectEmailThreadProvider.findUnique({
            where: {
              providerAccountId_providerThreadId: {
                providerAccountId: input.message.thread.providerAccountId,
                providerThreadId: input.message.thread.externalId,
              },
            },
          })
          if (mapping && mapping.threadId !== thread.id)
            throw new Error('Provider thread mapping changed during inbound admission')
          const message = await tx.prospectEmailMessage.create({
            data: {
              threadId: thread.id,
              organizationId: thread.organizationId,
              venueId: thread.venueId,
              contactId: thread.contactId,
              direction:
                input.message.direction === 'INBOUND'
                  ? 'INBOUND'
                  : input.message.direction === 'OUTBOUND'
                    ? 'OUTBOUND'
                    : 'INBOUND',
              status: input.message.direction === 'OUTBOUND' ? 'SENT' : 'RECEIVED',
              providerAccountId: input.message.message.providerAccountId,
              providerMessageId: input.message.message.externalId,
              internetMessageId: input.message.rfcMessageId,
              inReplyTo: input.message.inReplyTo,
              references: [...input.message.references],
              fromAddress: input.message.from[0]?.email ?? 'unknown@invalid.local',
              toAddresses: input.message.to.map((item) => item.email),
              ccAddresses: input.message.cc.map((item) => item.email),
              bccAddresses: input.message.bcc.map((item) => item.email),
              subject: input.message.subject,
              ...bodyProjection,
              attachmentMetadata: json(input.message.attachments),
              occurredAt: input.message.internalDate,
            },
          })
          await tx.prospectEmailThreadProvider.upsert({
            where: {
              providerAccountId_providerThreadId: {
                providerAccountId: input.message.thread.providerAccountId,
                providerThreadId: input.message.thread.externalId,
              },
            },
            create: {
              threadId: thread.id,
              providerAccountId: input.message.thread.providerAccountId,
              providerThreadId: input.message.thread.externalId,
            },
            update: { lastSeenAt: input.ingestedAt },
          })
          if (!thread.lastMessageAt || thread.lastMessageAt < input.message.internalDate) {
            await tx.prospectEmailThread.update({
              where: { id: thread.id },
              data: { lastMessageAt: input.message.internalDate },
            })
          }
          return message
        })
        return { canonicalMessageId: created.id, inserted: true }
      })
    },
    async appendRelationshipReply(input) {
      await withTenantIsolationBypass(() => recordProspectInboundReplyAction(input))
      const providerEventId = `reply-signal:${input.canonicalMessageId}`
      const eventIdentity = {
        providerAccountId: input.providerAccountId,
        providerEventId,
      }
      try {
        await withTenantIsolationBypass(() => db.$transaction(async (tx) => {
          const existing = await tx.prospectEmailEvent.findUnique({
            where: { providerAccountId_providerEventId: eventIdentity },
          })
          if (existing) {
            if (existing.emailMessageId !== input.canonicalMessageId ||
              existing.eventType !== 'crm.reply_received.signal')
              throw new Error('Reply signal marker conflicts with canonical message')
            return
          }
          const account = await tx.correspondenceProviderAccount.findUniqueOrThrow({
            where: { id: input.providerAccountId },
            select: { provider: true },
          })
          await publishCrmOperationalSignal({
            client: tx,
            input: {
              signal: 'reply_received',
              scope: { kind: 'platform' },
              linkedObjectType: 'ProspectEmailMessage',
              linkedObjectId: input.canonicalMessageId,
              summary: account.provider === 'FAKE'
                ? 'SYNTHETIC FAKE-provider reply was matched to its isolated canonical rehearsal thread; no venue sent it.'
                : 'A Gmail reply was matched to one canonical prospect thread.',
            },
          })
          await tx.prospectEmailEvent.create({
            data: {
              emailMessageId: input.canonicalMessageId,
              providerAccountId: input.providerAccountId,
              providerEventId,
              eventType: 'crm.reply_received.signal',
              payload: {
                canonicalThreadId: input.canonicalThreadId,
                prospectOrganizationId: input.prospectOrganizationId,
              },
              occurredAt: input.occurredAt,
            },
          })
        }))
      } catch (error) {
        if (!isUniqueConflict(error)) throw error
        const winner = await withTenantIsolationBypass(() =>
          db.prospectEmailEvent.findUnique({
            where: { providerAccountId_providerEventId: eventIdentity },
          }),
        )
        if (!winner || winner.emailMessageId !== input.canonicalMessageId ||
          winner.eventType !== 'crm.reply_received.signal') throw error
      }
    },
    async holdFollowups(input) {
      if (input.followupIds.length === 0) return
      await withTenantIsolationBypass(() =>
        db.prospectFollowup.updateMany({
          where: { id: { in: [...input.followupIds] }, status: 'PENDING' },
          data: {
            status: 'ON_HOLD_REPLY_RECEIVED',
            reason: `Held by inbound message ${input.causedByCanonicalMessageId}`,
          },
        }),
      )
    },
    async quarantine(input) {
      const accountId = input.message?.message.providerAccountId ?? null
      const identity = input.receiptId
        ? `receipt:${input.receiptId}`
        : input.message
          ? [
              'message',
              input.reason,
              input.message.message.provider,
              input.message.message.providerAccountId,
              input.message.message.mailboxId,
              input.message.message.externalId,
            ].join(':')
          : null
      const quarantineId = identity
        ? `inbound-quarantine-${createHash('sha256').update(identity).digest('hex').slice(0, 40)}`
        : undefined
      let quarantine: { id: string }
      try {
        quarantine = await withTenantIsolationBypass<{ id: string }>(() =>
          db.prospectInboundQuarantine.create({
            data: {
              ...(quarantineId ? { id: quarantineId } : {}),
              receiptId: input.receiptId,
              providerAccountId: accountId,
              reason: input.reason,
              detail: quarantineDetail(input.reason),
              ...(input.message
                ? {
                    messageSnapshot: json({
                      providerMessageId: input.message.message.externalId,
                      providerThreadId: input.message.thread.externalId,
                      rfcMessageId: input.message.rfcMessageId,
                      from: input.message.from,
                      to: input.message.to,
                      subject: input.message.subject,
                      occurredAt: input.message.internalDate,
                    }),
                  }
                : {}),
              candidateThreadIds: [...(input.candidateThreadIds ?? [])],
              occurredAt: input.occurredAt,
            },
            select: { id: true },
          }),
        )
      } catch (error) {
        if (!quarantineId || !isUniqueConflict(error)) throw error
        quarantine = { id: quarantineId }
      }
      // A receipt-only quarantine has no trustworthy provider source in this
      // input. For a supplied message, label it only when both provider refs
      // agree and the canonical account still owns that mailbox.
      let providerLabel = 'provider'
      const messageRef = input.message?.message
      const threadRef = input.message?.thread
      if (messageRef && threadRef &&
        messageRef.provider === threadRef.provider &&
        messageRef.providerAccountId === threadRef.providerAccountId &&
        messageRef.mailboxId === threadRef.mailboxId) {
        try {
          const account = await withTenantIsolationBypass(() =>
            db.correspondenceProviderAccount.findUnique({
              where: { id: messageRef.providerAccountId },
              select: { provider: true, externalAccountId: true },
            }),
          )
          if (account?.provider === messageRef.provider &&
            account.externalAccountId === messageRef.mailboxId) {
            providerLabel = account.provider === 'FAKE' ? 'SYNTHETIC FAKE-provider'
              : account.provider === 'GMAIL' ? 'Gmail' : 'provider'
          }
        } catch {
          // Quarantine and its operational signal remain durable with neutral
          // wording if provenance cannot be read at signal time.
        }
      }
      await publishCrmOperationalSignal({
        input: {
          signal: 'gmail_sync_failed',
          scope: { kind: 'platform' },
          linkedObjectType: 'ProspectInboundQuarantine',
          linkedObjectId: quarantine.id,
          summary: `Inbound ${providerLabel} content was quarantined: ${input.reason}.`,
        },
      })
    },
    async getSyncCursor(mailbox) {
      const account = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.findUnique({
          where: { id: mailbox.providerAccountId },
          select: { syncCursor: true },
        }),
      )
      return account?.syncCursor ?? null
    },
    async commitSyncCursor(input) {
      const result = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.updateMany({
          where: {
            id: input.mailbox.providerAccountId,
            provider: input.mailbox.provider,
            externalAccountId: input.mailbox.mailboxId,
            syncCursor: input.expectedCursor,
            connectionStatus: { in: ['CONNECTED', 'DEGRADED'] },
          },
          data: {
            syncCursor: input.cursor,
            lastSuccessfulSyncAt: input.completedAt,
            ...(input.mode === 'FULL_RECONCILIATION'
              ? { lastReconciliationAt: input.completedAt }
              : {}),
            connectionStatus: 'CONNECTED',
            healthErrorCode: null,
            healthErrorSummary: null,
          },
        }),
      )
      if (result.count !== 1) throw new CursorConflict()
    },
    async clearExpiredSyncCursor(input) {
      const result = await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.updateMany({
          where: {
            id: input.mailbox.providerAccountId,
            provider: input.mailbox.provider,
            externalAccountId: input.mailbox.mailboxId,
            syncCursor: input.expectedCursor,
            connectionStatus: { in: ['CONNECTED', 'DEGRADED'] },
          },
          data: { syncCursor: null },
        }),
      )
      if (result.count !== 1) throw new CursorConflict()
    },
    async saveWatch(input) {
      await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.update({
          where: { id: input.mailbox.providerAccountId },
          // Watch renewal is transport state only. The ingestion cursor advances
          // exclusively after synchronize() durably handles every page/message.
          data: { watchExpiration: input.watch.expiresAt },
        }),
      )
    },
    async recordHealth(input) {
      await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.update({
          where: { id: input.mailbox.providerAccountId },
          data:
            input.state === 'SUCCEEDED'
              ? {
                  lastHealthCheckAt: input.occurredAt,
                  healthErrorCode: null,
                  healthErrorSummary: null,
                }
              : {
                  lastHealthCheckAt: input.occurredAt,
                  connectionStatus: 'DEGRADED',
                  healthErrorCode: input.operation,
                  healthErrorSummary: healthFailureSummary(input.operation),
                },
        }),
      )
    },
  }
}

export function replyTokenHash(value: string) {
  return createHash('sha256').update(value).digest('hex')
}
