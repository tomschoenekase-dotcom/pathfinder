import { createHash } from 'node:crypto'

import { db } from '../client'
import { evaluateProspectSendRatePolicy } from './prospect-send-rate-policy'

type Client = typeof db

const TERMINAL_ITEM_STATES = [
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'COMPLAINED',
  'SUPPRESSED',
  'PERMANENTLY_FAILED',
  'AMBIGUOUS',
  'SKIPPED_IDENTITY_CHANGED',
  'CANCELLED',
] as const

export type FrozenProspectSend = {
  outboxId: string
  operationId: string
  claimOwner: string
  provider: 'GMAIL' | 'FAKE'
  providerAccountId: string
  externalAccountId: string
  credentialReferenceId: string
  mailboxAddress: string
  idempotencyKey: string
  attemptCount: number
  recipient: string
  subject: string
  textBody: string
  htmlBody: string | null
  headers: unknown
}

export class ProspectSendOutboxError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'DISABLED' | 'SUPPRESSED',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectSendOutboxError'
  }
}

function identityHash(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('hex')
}

function deliveryControlAllowsRecipient(
  control:
    | { deliveryEnabled: boolean; internalOnly: boolean; internalAllowlist: string[] }
    | null
    | undefined,
  recipient: string,
): boolean {
  if (!control?.deliveryEnabled) return false
  if (!control.internalOnly) return true
  const normalizedRecipient = recipient.toLowerCase()
  return control.internalAllowlist.some(
    (allowedRecipient) => allowedRecipient.toLowerCase() === normalizedRecipient,
  )
}

export async function finalizeProspectSendBatch(
  batchId: string,
  client: Client = db,
): Promise<void> {
  const [batch, unfinished, ambiguous, failed] = await Promise.all([
    client.prospectSendBatch.findUnique({ where: { id: batchId }, select: { id: true } }),
    client.prospectSendItem.count({
      where: { batchId, status: { notIn: [...TERMINAL_ITEM_STATES] } },
    }),
    client.prospectSendItem.count({ where: { batchId, status: 'AMBIGUOUS' } }),
    client.prospectSendItem.count({
      where: {
        batchId,
        status: {
          in: [
            'BOUNCED',
            'COMPLAINED',
            'SUPPRESSED',
            'PERMANENTLY_FAILED',
            'SKIPPED_IDENTITY_CHANGED',
            'CANCELLED',
          ],
        },
      },
    }),
  ])
  if (!batch || unfinished) return
  await client.prospectSendBatch.update({
    where: { id: batchId },
    data: {
      status: ambiguous ? 'ATTENTION_REQUIRED' : failed ? 'PARTIAL' : 'COMPLETE',
      completedAt: new Date(),
    },
  })
}

/** Claims one operation using a lease. An unexpired CLAIMED operation is never claimable. */
export async function claimProspectSendOutboxAction(
  input: { outboxId: string; workerId: string; leaseMs?: number; now?: Date },
  client: Client = db,
): Promise<FrozenProspectSend | null> {
  const now = input.now ?? new Date()
  const claimExpiresAt = new Date(now.getTime() + (input.leaseMs ?? 120_000))
  const outcome = await client.$transaction(async (tx) => {
    const operationBeforeClaim = await tx.prospectSendOutbox.findUnique({
      where: { id: input.outboxId },
      include: {
        providerAccount: true,
        sendItem: {
          include: {
            batch: { include: { campaign: true } },
            member: { include: { contact: true } },
          },
        },
      },
    })
    if (!operationBeforeClaim) return { send: null, terminalBatchId: null }
    const claimable =
      (['PENDING', 'RETRYABLE'] as const).includes(
        operationBeforeClaim.status as 'PENDING' | 'RETRYABLE',
      ) && !operationBeforeClaim.claimOwner
        ? true
        : operationBeforeClaim.status === 'CLAIMED' &&
          Boolean(operationBeforeClaim.claimExpiresAt && operationBeforeClaim.claimExpiresAt < now)
    if (!claimable || operationBeforeClaim.availableAt > now) {
      return { send: null, terminalBatchId: null }
    }

    // PostgreSQL row locks serialize reservations across workers. The ordering is fixed
    // (mailbox, then campaign) so different operations cannot overbook configured lanes.
    await tx.$queryRaw`SELECT "id" FROM "correspondence_provider_accounts" WHERE "id" = ${operationBeforeClaim.providerAccountId} FOR UPDATE`
    await tx.$queryRaw`SELECT "id" FROM "prospect_outreach_campaigns" WHERE "id" = ${operationBeforeClaim.sendItem.batch.campaignId} FOR UPDATE`

    const startOfUtcDay = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    )
    const reservedToday = {
      OR: [
        { status: 'SENT' as const, terminalAt: { gte: startOfUtcDay } },
        { status: 'CLAIMED' as const, claimExpiresAt: { gt: now } },
      ],
    }
    const recipientDomain = operationBeforeClaim.sendItem.recipientEmailSnapshot
      .toLowerCase()
      .split('@')
      .at(-1)
    if (!recipientDomain) return { send: null, terminalBatchId: null }
    const [mailboxReservedToday, campaignReservedToday, domainReservedToday, latestReservation] =
      await Promise.all([
        tx.prospectSendOutbox.count({
          where: { providerAccountId: operationBeforeClaim.providerAccountId, ...reservedToday },
        }),
        tx.prospectSendOutbox.count({
          where: {
            sendItem: { batch: { campaignId: operationBeforeClaim.sendItem.batch.campaignId } },
            ...reservedToday,
          },
        }),
        tx.prospectSendOutbox.count({
          where: {
            providerAccountId: operationBeforeClaim.providerAccountId,
            sendItem: {
              recipientEmailSnapshot: { endsWith: `@${recipientDomain}`, mode: 'insensitive' },
            },
            ...reservedToday,
          },
        }),
        tx.prospectSendOutbox.findFirst({
          where: { providerAccountId: operationBeforeClaim.providerAccountId, ...reservedToday },
          orderBy: { updatedAt: 'desc' },
          select: { updatedAt: true },
        }),
      ])
    const rateDecision = evaluateProspectSendRatePolicy({
      now,
      operationId: operationBeforeClaim.operationId,
      mailboxDailyCap: operationBeforeClaim.providerAccount.dailySendCap,
      campaignDailyCap: operationBeforeClaim.sendItem.batch.campaign.dailySendCap,
      domainDailyCap: operationBeforeClaim.providerAccount.perDomainDailyCap,
      mailboxReservedToday,
      campaignReservedToday,
      domainReservedToday,
      minimumDelaySeconds: operationBeforeClaim.providerAccount.minimumDelaySeconds,
      jitterSeconds: operationBeforeClaim.providerAccount.jitterSeconds,
      lastReservedAt: latestReservation?.updatedAt ?? null,
    })
    if (!rateDecision.allowed) {
      await tx.prospectSendOutbox.updateMany({
        where: {
          id: operationBeforeClaim.id,
          OR: [
            { status: { in: ['PENDING', 'RETRYABLE'] }, claimOwner: null },
            { status: 'CLAIMED', claimExpiresAt: { lt: now } },
          ],
        },
        data: {
          status: 'RETRYABLE',
          availableAt: rateDecision.retryAt,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: rateDecision.reason,
          lastErrorMessage: 'Deferred by the configured prospect delivery rate policy',
          lastErrorRetryable: true,
        },
      })
      return { send: null, terminalBatchId: null }
    }
    const claimed = await tx.prospectSendOutbox.updateMany({
      where: {
        id: input.outboxId,
        availableAt: { lte: now },
        OR: [
          { status: { in: ['PENDING', 'RETRYABLE'] }, claimOwner: null },
          { status: 'CLAIMED', claimExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: 'CLAIMED',
        claimOwner: input.workerId,
        claimExpiresAt,
        attemptCount: { increment: 1 },
        lastErrorCode: null,
        lastErrorMessage: null,
        lastErrorRetryable: null,
      },
    })
    if (claimed.count !== 1) return { send: null, terminalBatchId: null }

    const operation = await tx.prospectSendOutbox.findUnique({
      where: { id: input.outboxId },
      include: {
        providerAccount: true,
        sendItem: {
          include: {
            batch: { include: { campaign: true } },
            member: { include: { contact: true } },
          },
        },
      },
    })
    if (!operation || operation.claimOwner !== input.workerId) {
      return { send: null, terminalBatchId: null }
    }
    const { providerAccount, sendItem } = operation
    const control = await tx.prospectDeliveryControl.findUnique({ where: { id: 'global' } })
    if (
      !deliveryControlAllowsRecipient(control, sendItem.recipientEmailSnapshot) ||
      !providerAccount.deliveryEnabled ||
      providerAccount.pausedAt ||
      providerAccount.connectionStatus !== 'CONNECTED' ||
      sendItem.batch.campaign.pausedAt ||
      sendItem.batch.campaign.status === 'CANCELLED'
    ) {
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: 'CANCELLED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: 'DELIVERY_DISABLED',
          lastErrorMessage: 'A global, mailbox, or campaign delivery control is disabled',
          lastErrorRetryable: false,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: 'CANCELLED', lastErrorCode: 'DELIVERY_DISABLED' },
      })
      return { send: null, terminalBatchId: sendItem.batchId }
    }
    const contact = sendItem.member.contact
    const contactHash = contact?.normalizedEmail ? identityHash(contact.normalizedEmail) : null
    if (
      !contact ||
      contact.archivedAt ||
      contact.doNotContact ||
      contact.emailReadiness !== 'VALID' ||
      contact.permissionState === 'OPTED_OUT' ||
      contact.permissionState === 'PROHIBITED' ||
      contact.suppressedAt ||
      contact.unsubscribedAt ||
      contactHash !== sendItem.recipientIdentityHash
    ) {
      const identityChanged = Boolean(contactHash && contactHash !== sendItem.recipientIdentityHash)
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: 'SUPPRESSED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: identityChanged ? 'RECIPIENT_IDENTITY_CHANGED' : 'CONTACT_SUPPRESSED',
          lastErrorMessage:
            'Recipient eligibility changed after approval; no provider call occurred',
          lastErrorRetryable: false,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: {
          status: identityChanged ? 'SKIPPED_IDENTITY_CHANGED' : 'SUPPRESSED',
          lastErrorCode: identityChanged ? 'RECIPIENT_IDENTITY_CHANGED' : 'CONTACT_SUPPRESSED',
          lastErrorMessage:
            'Recipient eligibility changed after approval; no provider call occurred',
        },
      })
      return { send: null, terminalBatchId: sendItem.batchId }
    }
    if (!providerAccount.credentialReferenceId) {
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: 'PERMANENTLY_FAILED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: 'CREDENTIAL_REFERENCE_MISSING',
          lastErrorMessage: 'Provider account has no encrypted credential reference',
          lastErrorRetryable: false,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: 'PERMANENTLY_FAILED', lastErrorCode: 'CREDENTIAL_REFERENCE_MISSING' },
      })
      return { send: null, terminalBatchId: sendItem.batchId }
    }
    if (providerAccount.provider === 'RESEND') {
      throw new ProspectSendOutboxError(
        'DISABLED',
        'Resend is prohibited for prospect correspondence operations',
      )
    }
    return {
      terminalBatchId: null,
      send: {
        outboxId: operation.id,
        operationId: operation.operationId,
        claimOwner: input.workerId,
        provider: providerAccount.provider,
        providerAccountId: providerAccount.id,
        externalAccountId: providerAccount.externalAccountId,
        credentialReferenceId: providerAccount.credentialReferenceId,
        mailboxAddress: providerAccount.mailboxAddress,
        idempotencyKey: operation.providerIdempotencyKey,
        attemptCount: operation.attemptCount,
        recipient: sendItem.recipientEmailSnapshot,
        subject: sendItem.subjectSnapshot,
        textBody: sendItem.textBodySnapshot,
        htmlBody: sendItem.htmlBodySnapshot,
        headers: sendItem.headerSnapshot,
      } satisfies FrozenProspectSend,
    }
  })
  if (outcome.terminalBatchId) await finalizeProspectSendBatch(outcome.terminalBatchId, client)
  return outcome.send
}

/**
 * Revalidates the exact live claim immediately before a provider call. This closes the
 * ordinary claim-to-send stop window and fails closed when authority or the lease changed.
 */
export async function revalidateProspectSendOutboxClaimAction(
  input: { outboxId: string; workerId: string; now?: Date },
  client: Client = db,
): Promise<boolean> {
  const now = input.now ?? new Date()
  return client.$transaction(async (tx) => {
    const [control, operation] = await Promise.all([
      tx.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
      tx.prospectSendOutbox.findUnique({
        where: { id: input.outboxId },
        include: {
          providerAccount: true,
          sendItem: { include: { batch: { include: { campaign: true } } } },
        },
      }),
    ])
    if (
      !operation ||
      operation.status !== 'CLAIMED' ||
      operation.claimOwner !== input.workerId ||
      !operation.claimExpiresAt ||
      operation.claimExpiresAt <= now
    ) {
      return false
    }
    const { providerAccount, sendItem } = operation
    if (
      !deliveryControlAllowsRecipient(control, sendItem.recipientEmailSnapshot) ||
      providerAccount.provider === 'RESEND' ||
      !providerAccount.capabilities.includes('SEND') ||
      !providerAccount.deliveryEnabled ||
      providerAccount.pausedAt ||
      providerAccount.connectionStatus !== 'CONNECTED' ||
      sendItem.batch.campaign.pausedAt ||
      sendItem.batch.campaign.status === 'CANCELLED'
    ) {
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: 'CANCELLED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER',
          lastErrorMessage: 'Delivery authority was disabled after claim and before provider call',
          lastErrorRetryable: false,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: 'CANCELLED', lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER' },
      })
      return false
    }
    return true
  })
}

export async function recordProspectSendFailureAction(
  input: {
    outboxId: string
    workerId: string
    code: string
    retryable: boolean
    acceptanceAmbiguous: boolean
    retryAt?: Date
    now?: Date
  },
  client: Client = db,
): Promise<void> {
  const now = input.now ?? new Date()
  const failureCode = /^[A-Z][A-Z0-9_]{2,99}$/u.test(input.code)
    ? input.code
    : 'UNCLASSIFIED_PROVIDER_FAILURE'
  const failureMessage = `Prospect delivery failed (${failureCode}).`
  const outboxStatus = input.acceptanceAmbiguous
    ? 'AMBIGUOUS'
    : input.retryable
      ? 'RETRYABLE'
      : 'PERMANENTLY_FAILED'
  const itemStatus = input.acceptanceAmbiguous
    ? 'AMBIGUOUS'
    : input.retryable
      ? 'FAILED'
      : 'PERMANENTLY_FAILED'
  const batchId = await client.$transaction(async (tx) => {
    const operation = await tx.prospectSendOutbox.findUnique({
      where: { id: input.outboxId },
      include: { sendItem: { select: { id: true, batchId: true } } },
    })
    if (!operation) throw new ProspectSendOutboxError('NOT_FOUND', 'Outbox operation not found')
    const completed = await tx.prospectSendOutbox.updateMany({
      where: {
        id: operation.id,
        status: 'CLAIMED',
        claimOwner: input.workerId,
        claimExpiresAt: { gt: now },
      },
      data: {
        status: outboxStatus,
        availableAt: input.retryAt ?? new Date(now.getTime() + 60_000),
        claimOwner: null,
        claimExpiresAt: null,
        lastErrorCode: failureCode,
        lastErrorMessage: failureMessage,
        lastErrorRetryable: input.retryable,
        ambiguousSince: input.acceptanceAmbiguous ? now : null,
        terminalAt: input.retryable ? null : now,
      },
    })
    if (completed.count !== 1) {
      throw new ProspectSendOutboxError(
        'CONFLICT',
        'Worker completion was rejected because its operation lease is no longer live',
      )
    }
    await tx.prospectSendItem.update({
      where: { id: operation.sendItem.id },
      data: {
        status: itemStatus,
        lastErrorCode: failureCode,
        lastErrorMessage: failureMessage,
      },
    })
    return operation.sendItem.batchId
  })
  await finalizeProspectSendBatch(batchId, client)
}

export async function recordProspectSendSuccessAction(
  input: {
    outboxId: string
    workerId: string
    providerMessageId: string
    providerThreadId: string
    internetMessageId?: string
    acceptedAt?: Date
    now?: Date
  },
  client: Client = db,
): Promise<void> {
  const acceptedAt = input.acceptedAt ?? new Date()
  const now = input.now ?? new Date()
  await client.$transaction(async (tx) => {
    const operation = await tx.prospectSendOutbox.findUnique({
      where: { id: input.outboxId },
      include: {
        providerAccount: true,
        sendItem: {
          include: {
            batch: true,
            member: { include: { organization: { include: { opportunity: true } } } },
          },
        },
      },
    })
    if (!operation) throw new ProspectSendOutboxError('NOT_FOUND', 'Outbox operation not found')
    const completed = await tx.prospectSendOutbox.updateMany({
      where: {
        id: operation.id,
        status: 'CLAIMED',
        claimOwner: input.workerId,
        claimExpiresAt: { gt: now },
      },
      data: {
        status: 'SENT',
        terminalAt: acceptedAt,
        claimOwner: null,
        claimExpiresAt: null,
      },
    })
    if (completed.count !== 1) {
      throw new ProspectSendOutboxError(
        'CONFLICT',
        'Worker completion was rejected because its operation lease is no longer live',
      )
    }
    const item = operation.sendItem
    const canonicalThreadId = `pt_${createHash('sha256').update(item.id).digest('hex').slice(0, 24)}`
    const replyTokenHash = createHash('sha256')
      .update(`provider-thread:${canonicalThreadId}`)
      .digest('hex')
    const thread = await tx.prospectEmailThread.upsert({
      where: { replyTokenHash },
      create: {
        id: canonicalThreadId,
        organizationId: item.member.organizationId,
        venueId: item.member.venueId,
        contactId: item.member.contactId,
        subject: item.subjectSnapshot,
        replyTokenHash,
        lastMessageAt: acceptedAt,
      },
      update: { lastMessageAt: acceptedAt },
    })
    await tx.prospectEmailThreadProvider.upsert({
      where: {
        providerAccountId_providerThreadId: {
          providerAccountId: operation.providerAccountId,
          providerThreadId: input.providerThreadId,
        },
      },
      create: {
        threadId: thread.id,
        providerAccountId: operation.providerAccountId,
        providerThreadId: input.providerThreadId,
        lastSeenAt: acceptedAt,
      },
      update: { lastSeenAt: acceptedAt },
    })
    const message = await tx.prospectEmailMessage.create({
      data: {
        threadId: thread.id,
        organizationId: item.member.organizationId,
        venueId: item.member.venueId,
        contactId: item.member.contactId,
        sendItemId: item.id,
        direction: 'OUTBOUND',
        status: 'SENT',
        providerAccountId: operation.providerAccountId,
        providerMessageId: input.providerMessageId,
        internetMessageId: input.internetMessageId ?? null,
        fromAddress: operation.providerAccount.mailboxAddress,
        toAddresses: [item.recipientEmailSnapshot],
        subject: item.subjectSnapshot,
        bodyPreview: item.textBodySnapshot.replace(/\s+/gu, ' ').trim().slice(0, 500),
        bodyRetentionState: 'NOT_STORED',
        sourceReference: `https://mail.google.com/mail/u/${encodeURIComponent(
          operation.providerAccount.mailboxAddress,
        )}/#all/${encodeURIComponent(input.providerMessageId)}`,
        occurredAt: acceptedAt,
      },
    })
    await tx.prospectSendItem.update({
      where: { id: item.id },
      data: {
        status: 'SENT',
        providerMessageId: input.providerMessageId,
        providerOperationId: operation.operationId,
        sentAt: acceptedAt,
      },
    })
    await tx.prospectOutreachDraft.update({ where: { id: item.draftId }, data: { status: 'SENT' } })
    await tx.prospectCampaignMember.update({
      where: { id: item.memberId },
      data: { status: 'SENT' },
    })
    await tx.prospectActivity.create({
      data: {
        organizationId: item.member.organizationId,
        venueId: item.member.venueId,
        contactId: item.member.contactId,
        type: 'OUTREACH_SENT',
        summary: 'Approved prospect correspondence accepted by Gmail',
        evidence: {
          messageId: message.id,
          sendItemId: item.id,
          operationId: operation.operationId,
          providerAccountId: operation.providerAccountId,
        },
        actorId: 'system:prospect-correspondence',
        occurredAt: acceptedAt,
      },
    })
  })
  const operation = await client.prospectSendOutbox.findUnique({
    where: { id: input.outboxId },
    select: { sendItem: { select: { batchId: true } } },
  })
  if (operation) await finalizeProspectSendBatch(operation.sendItem.batchId, client)
}

const DELIVERY_PRECEDENCE = {
  STAGED: 0,
  QUEUED: 1,
  SENT: 2,
  DELAYED: 3,
  DELIVERED: 4,
  RECEIVED: 5,
  BOUNCED: 6,
  COMPLAINED: 7,
  SUPPRESSED: 8,
  FAILED: 9,
} as const

/** Arrival order cannot regress the current canonical message projection. */
export function foldProspectEmailStatus(
  current: keyof typeof DELIVERY_PRECEDENCE,
  incoming: keyof typeof DELIVERY_PRECEDENCE,
): keyof typeof DELIVERY_PRECEDENCE {
  return DELIVERY_PRECEDENCE[incoming] > DELIVERY_PRECEDENCE[current] ? incoming : current
}
