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
        const account = await db.correspondenceProviderAccount.findUnique({
          where: { id: input.providerAccountId },
          select: { id: true },
        })
        if (!account) throw new Error('Provider account does not exist')
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
          return {
            inserted: false,
            receipt: {
              id: existing.id,
              provider: input.provider,
              providerAccountId: input.providerAccountId,
              mailboxId: input.mailboxId,
              externalReceiptId: input.externalReceiptId,
              state: canonicalReceiptState(existing.status),
              receivedAt: existing.createdAt,
            },
          }
        }
        const receipt = await db.prospectEmailWebhookReceipt.create({
          data: {
            provider: input.provider,
            providerAccountId: input.providerAccountId,
            providerMailboxKey: input.mailboxId,
            providerEventId: input.externalReceiptId,
            eventType: 'provider.message.notification',
            payload: { mailboxId: input.mailboxId },
            createdAt: input.receivedAt,
          },
        })
        return { inserted: true, receipt: { ...input, id: receipt.id, state: 'RECEIVED' } }
      })
    },
    async markReceiptState(receiptId, state) {
      await withTenantIsolationBypass(() =>
        db.prospectEmailWebhookReceipt.update({
          where: { id: receiptId },
          data: {
            status: receiptStatus[state],
            attemptCount: { increment: 1 },
            processingError:
              state === 'RETRYABLE_FAILURE'
                ? 'Provider message retrieval failed before canonical ingestion.'
                : null,
            ...(['PROCESSED', 'QUARANTINED', 'PERMANENT_FAILURE'].includes(state)
              ? { processedAt: new Date() }
              : {}),
          },
        }),
      )
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
              where: { internetMessageId: { in: references } },
              select: { thread: { include } },
              take: 20,
            })
          : []
        const participantEmails = [...message.from, ...message.to]
          .map((item) => item.email.toLowerCase())
          .slice(0, 20)
        const participantThreads = participantEmails.length
          ? await db.prospectEmailThread.findMany({
              where: { contact: { normalizedEmail: { in: participantEmails } } },
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
          select: { id: true },
        })
        if (existing) return { canonicalMessageId: existing.id, inserted: false }
        const bodyProjection = projectGmailBodyForPersistence({
          message: input.message,
          ingestedAt: input.ingestedAt,
          policy: bodyPersistence,
        })
        const created = await db.$transaction(async (tx) => {
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
      await publishCrmOperationalSignal({
        input: {
          signal: 'reply_received',
          scope: { kind: 'platform' },
          linkedObjectType: 'ProspectEmailMessage',
          linkedObjectId: input.canonicalMessageId,
          summary: 'A Gmail reply was matched to one canonical prospect thread.',
        },
      })
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
      const quarantine = await withTenantIsolationBypass(() =>
        db.prospectInboundQuarantine.create({
          data: {
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
        }),
      )
      await publishCrmOperationalSignal({
        input: {
          signal: 'gmail_sync_failed',
          scope: { kind: 'platform' },
          linkedObjectType: 'ProspectInboundQuarantine',
          linkedObjectId: quarantine.id,
          summary: `Inbound Gmail content was quarantined: ${input.reason}.`,
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
      await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.update({
          where: { id: input.mailbox.providerAccountId },
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
    },
    async saveWatch(input) {
      await withTenantIsolationBypass(() =>
        db.correspondenceProviderAccount.update({
          where: { id: input.mailbox.providerAccountId },
          data: { watchExpiration: input.watch.expiresAt, syncCursor: input.watch.cursor },
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
