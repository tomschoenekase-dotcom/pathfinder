import { createHash } from 'node:crypto'

import {
  launchAttachmentsFromSnapshot,
  launchAttachmentsSha256,
} from '@pathfinder/contracts/venue-launch-asset-node'
import type { VenueLaunchAsset } from '@pathfinder/contracts/venue-launch-asset'

import { db } from '../client'
import { evaluateProspectSendRatePolicy } from './prospect-send-rate-policy'
import {
  prospectOperationalContentHash,
  requireCurrentProspectLaunchAttachments,
  requireSameLaunchAttachments,
} from './prospect-launch-attachments'

type Client = typeof db
type TransactionClient = Parameters<Parameters<Client['$transaction']>[0]>[0]

/** One provider send followed by at most three lookup-only reconciliation attempts. */
export const MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS = 4
export const PROSPECT_SEND_RECONCILIATION_CODES = [
  'AMBIGUOUS_SEND',
  'UNCLASSIFIED_PROVIDER_FAILURE',
] as const

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
  launchAttachments: VenueLaunchAsset[]
}

function readFrozenLaunchAttachments(sendItem: {
  recipientEmailSnapshot: string
  subjectSnapshot: string
  textBodySnapshot: string
  htmlBodySnapshot: string | null
  contentHashSnapshot: string
  headerSnapshot: unknown
  draft?: { groundingSnapshot: unknown } | null
}): VenueLaunchAsset[] {
  const attachments = launchAttachmentsFromSnapshot(sendItem.headerSnapshot)
  if (!attachments.length) return attachments
  if (!sendItem.draft)
    throw new ProspectSendOutboxError('CONFLICT', 'Frozen draft snapshot is missing')
  requireSameLaunchAttachments(sendItem.draft.groundingSnapshot, sendItem.headerSnapshot)
  const declaredSha =
    sendItem.headerSnapshot && typeof sendItem.headerSnapshot === 'object'
      ? (sendItem.headerSnapshot as Record<string, unknown>).launchAttachmentsSha256
      : undefined
  if (declaredSha !== launchAttachmentsSha256(attachments)) {
    throw new ProspectSendOutboxError('CONFLICT', 'Frozen launch attachment digest does not match')
  }
  const contentHash = prospectOperationalContentHash(
    sendItem.recipientEmailSnapshot,
    sendItem.subjectSnapshot,
    sendItem.textBodySnapshot,
    sendItem.htmlBodySnapshot ?? '',
    { launchAttachments: attachments },
  )
  if (contentHash !== sendItem.contentHashSnapshot) {
    throw new ProspectSendOutboxError(
      'CONFLICT',
      'Frozen send content or launch attachments changed',
    )
  }
  return attachments
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

function recipientEligibility(
  contact:
    | {
        normalizedEmail: string | null
        archivedAt: Date | null
        doNotContact: boolean
        emailReadiness: string
        permissionState: string
        suppressedAt: Date | null
        unsubscribedAt: Date | null
      }
    | null
    | undefined,
  expectedIdentityHash: string,
) {
  const currentIdentityHash = contact?.normalizedEmail
    ? identityHash(contact.normalizedEmail)
    : null
  const identityChanged = Boolean(
    currentIdentityHash && currentIdentityHash !== expectedIdentityHash,
  )
  const eligible = Boolean(
    contact &&
    !contact.archivedAt &&
    !contact.doNotContact &&
    contact.emailReadiness === 'VALID' &&
    contact.permissionState !== 'OPTED_OUT' &&
    contact.permissionState !== 'PROHIBITED' &&
    !contact.suppressedAt &&
    !contact.unsubscribedAt &&
    currentIdentityHash === expectedIdentityHash,
  )
  return { eligible, identityChanged }
}

async function prospectReplyExistsBeforeProvider(
  tx: Pick<TransactionClient, 'prospectEmailMessage'>,
  sendItem: {
    createdAt: Date
    recipientEmailSnapshot: string
    member: { id: string; organizationId: string; contactId: string | null; status: string }
  },
): Promise<boolean> {
  if (sendItem.member.status === 'REPLIED') return true
  const reply = await tx.prospectEmailMessage.findFirst({
    where: {
      organizationId: sendItem.member.organizationId,
      direction: 'INBOUND',
      createdAt: { gte: sendItem.createdAt },
      OR: [
        {
          fromAddress: { equals: sendItem.recipientEmailSnapshot, mode: 'insensitive' },
        },
        {
          thread: { messages: { some: { sendItem: { memberId: sendItem.member.id } } } },
        },
        ...(sendItem.member.contactId ? [{ contactId: sendItem.member.contactId }] : []),
      ],
    },
    select: { id: true },
  })
  return Boolean(reply)
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
            draft: true,
          },
        },
      },
    })
    if (!operationBeforeClaim) return { send: null, terminalBatchId: null }
    const expiredPriorClaim =
      operationBeforeClaim.status === 'CLAIMED' &&
      operationBeforeClaim.attemptCount > 0 &&
      Boolean(operationBeforeClaim.claimExpiresAt && operationBeforeClaim.claimExpiresAt < now)
    const reconcileOnly =
      operationBeforeClaim.attemptCount < MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS &&
      (expiredPriorClaim ||
        (operationBeforeClaim.status === 'AMBIGUOUS' &&
          PROSPECT_SEND_RECONCILIATION_CODES.some(
            (code) => code === operationBeforeClaim.lastErrorCode,
          )))
    const claimable =
      (['PENDING', 'RETRYABLE'] as const).includes(
        operationBeforeClaim.status as 'PENDING' | 'RETRYABLE',
      ) && !operationBeforeClaim.claimOwner
        ? true
        : reconcileOnly && !operationBeforeClaim.claimOwner
          ? true
          : expiredPriorClaim &&
            operationBeforeClaim.attemptCount < MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS
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
    if (!reconcileOnly && !rateDecision.allowed) {
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
          {
            status: 'AMBIGUOUS',
            claimOwner: null,
            attemptCount: { lt: MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS },
            lastErrorCode: { in: [...PROSPECT_SEND_RECONCILIATION_CODES] },
          },
          {
            status: 'CLAIMED',
            claimExpiresAt: { lt: now },
            attemptCount: { lt: MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS },
          },
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
            draft: true,
          },
        },
      },
    })
    if (!operation || operation.claimOwner !== input.workerId) {
      return { send: null, terminalBatchId: null }
    }
    const { providerAccount, sendItem } = operation
    let launchAttachments: VenueLaunchAsset[]
    try {
      launchAttachments = readFrozenLaunchAttachments(sendItem)
    } catch {
      const stopped = await tx.prospectSendOutbox.updateMany({
        where: {
          id: operation.id,
          status: 'CLAIMED',
          claimOwner: input.workerId,
          claimExpiresAt: { equals: operation.claimExpiresAt, gt: now },
        },
        data: {
          status: 'CANCELLED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: 'FROZEN_LAUNCH_ATTACHMENT_INVALID',
          lastErrorMessage: 'Frozen launch attachment data did not match the approved send',
          lastErrorRetryable: false,
        },
      })
      if (stopped.count !== 1) return { send: null, terminalBatchId: null }
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: {
          status: 'CANCELLED',
          lastErrorCode: 'FROZEN_LAUNCH_ATTACHMENT_INVALID',
          lastErrorMessage: 'Frozen launch attachment data did not match the approved send',
        },
      })
      return { send: null, terminalBatchId: sendItem.batchId }
    }
    if (providerAccount.provider === 'RESEND') {
      throw new ProspectSendOutboxError(
        'DISABLED',
        'Resend is prohibited for prospect correspondence operations',
      )
    }
    const frozenSend: FrozenProspectSend = {
      outboxId: operation.id,
      operationId: operation.operationId,
      claimOwner: input.workerId,
      provider: providerAccount.provider,
      providerAccountId: providerAccount.id,
      externalAccountId: providerAccount.externalAccountId,
      credentialReferenceId: providerAccount.credentialReferenceId ?? '',
      mailboxAddress: providerAccount.mailboxAddress,
      idempotencyKey: operation.providerIdempotencyKey,
      attemptCount: operation.attemptCount,
      recipient: sendItem.recipientEmailSnapshot,
      subject: sendItem.subjectSnapshot,
      textBody: sendItem.textBodySnapshot,
      htmlBody: sendItem.htmlBodySnapshot,
      headers: sendItem.headerSnapshot,
      launchAttachments,
    }
    // The first provider call may already have succeeded. Recovery only reads the
    // sent mailbox and compares this exact frozen envelope; it cannot dispatch.
    if (reconcileOnly) {
      if (!providerAccount.credentialReferenceId) {
        await tx.prospectSendOutbox.update({
          where: { id: operation.id },
          data: {
            status: 'AMBIGUOUS',
            terminalAt: now,
            claimOwner: null,
            claimExpiresAt: null,
            lastErrorCode: 'RECOVERY_CREDENTIAL_MISSING',
            lastErrorMessage: 'The original mailbox credential is unavailable for readback',
            lastErrorRetryable: false,
          },
        })
        return { send: null, terminalBatchId: sendItem.batchId }
      }
      return { send: frozenSend, terminalBatchId: null }
    }
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
    const eligibility = recipientEligibility(contact, sendItem.recipientIdentityHash)
    if (!eligibility.eligible) {
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: 'SUPPRESSED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: eligibility.identityChanged
            ? 'RECIPIENT_IDENTITY_CHANGED'
            : 'CONTACT_SUPPRESSED',
          lastErrorMessage:
            'Recipient eligibility changed after approval; no provider call occurred',
          lastErrorRetryable: false,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: {
          status: eligibility.identityChanged ? 'SKIPPED_IDENTITY_CHANGED' : 'SUPPRESSED',
          lastErrorCode: eligibility.identityChanged
            ? 'RECIPIENT_IDENTITY_CHANGED'
            : 'CONTACT_SUPPRESSED',
          lastErrorMessage:
            'Recipient eligibility changed after approval; no provider call occurred',
        },
      })
      return { send: null, terminalBatchId: sendItem.batchId }
    }
    if (await prospectReplyExistsBeforeProvider(tx, sendItem)) {
      const ambiguous = operation.attemptCount > 1
      const replyCode = ambiguous
        ? 'REPLY_RECEIVED_AFTER_PRIOR_ATTEMPT'
        : 'REPLY_RECEIVED_BEFORE_PROVIDER'
      const replyMessage = ambiguous
        ? 'An inbound reply was recorded after a prior provider attempt; delivery outcome is ambiguous'
        : 'An inbound reply was recorded before provider delivery'
      await tx.prospectSendOutbox.update({
        where: { id: operation.id },
        data: {
          status: ambiguous ? 'AMBIGUOUS' : 'CANCELLED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: replyCode,
          lastErrorMessage: replyMessage,
          lastErrorRetryable: false,
          ambiguousSince: ambiguous ? now : null,
        },
      })
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: ambiguous ? 'AMBIGUOUS' : 'CANCELLED', lastErrorCode: replyCode },
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
    return { terminalBatchId: null, send: frozenSend }
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
  let terminalBatchId: string | null = null
  const allowed = await client.$transaction(async (tx) => {
    const [control, operation] = await Promise.all([
      tx.prospectDeliveryControl.findUnique({ where: { id: 'global' } }),
      tx.prospectSendOutbox.findUnique({
        where: { id: input.outboxId },
        include: {
          providerAccount: true,
          sendItem: {
            include: {
              batch: { include: { campaign: true } },
              member: {
                include: {
                  venue: { select: { id: true } },
                  contact: {
                    select: {
                      normalizedEmail: true,
                      doNotContact: true,
                      archivedAt: true,
                      emailReadiness: true,
                      permissionState: true,
                      suppressedAt: true,
                      unsubscribedAt: true,
                    },
                  },
                },
              },
              draft: true,
            },
          },
        },
      }),
    ])
    const now = input.now ?? new Date()
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
      const stopped = await tx.prospectSendOutbox.updateMany({
        where: {
          id: operation.id,
          status: 'CLAIMED',
          claimOwner: input.workerId,
          claimExpiresAt: { equals: operation.claimExpiresAt, gt: now },
        },
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
      if (stopped.count !== 1) return false
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: 'CANCELLED', lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER' },
      })
      terminalBatchId = sendItem.batchId
      return false
    }
    const eligibility = recipientEligibility(
      sendItem.member.contact,
      sendItem.recipientIdentityHash,
    )
    if (!eligibility.eligible) {
      const stopped = await tx.prospectSendOutbox.updateMany({
        where: {
          id: operation.id,
          status: 'CLAIMED',
          claimOwner: input.workerId,
          claimExpiresAt: { equals: operation.claimExpiresAt, gt: now },
        },
        data: {
          status: 'SUPPRESSED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: eligibility.identityChanged
            ? 'RECIPIENT_IDENTITY_CHANGED'
            : 'CONTACT_SUPPRESSED',
          lastErrorMessage: 'Recipient eligibility changed after claim and before provider call',
          lastErrorRetryable: false,
        },
      })
      if (stopped.count !== 1) return false
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: {
          status: eligibility.identityChanged ? 'SKIPPED_IDENTITY_CHANGED' : 'SUPPRESSED',
          lastErrorCode: eligibility.identityChanged
            ? 'RECIPIENT_IDENTITY_CHANGED'
            : 'CONTACT_SUPPRESSED',
          lastErrorMessage: 'Recipient eligibility changed after claim and before provider call',
        },
      })
      terminalBatchId = sendItem.batchId
      return false
    }
    let launchAttachments: VenueLaunchAsset[]
    let attachmentsCurrent = true
    const attachmentsCheckedAt = input.now ?? new Date()
    try {
      launchAttachments = readFrozenLaunchAttachments(sendItem)
      if (launchAttachments.length) {
        const prospectVenueId = sendItem.draft.venueId ?? sendItem.member.venue?.id ?? null
        if (!prospectVenueId)
          throw new Error('Frozen launch attachments have no prospect venue scope')
        await requireCurrentProspectLaunchAttachments(prospectVenueId, launchAttachments, {
          client: tx,
          allowFrozenVerifiedPrintAttachments: true,
        })
      }
    } catch {
      launchAttachments = []
      attachmentsCurrent = false
    }
    if (operation.claimExpiresAt <= attachmentsCheckedAt) return false
    if (!attachmentsCurrent) {
      const stopped = await tx.prospectSendOutbox.updateMany({
        where: {
          id: operation.id,
          status: 'CLAIMED',
          claimOwner: input.workerId,
          claimExpiresAt: { equals: operation.claimExpiresAt, gt: attachmentsCheckedAt },
        },
        data: {
          status: 'CANCELLED',
          terminalAt: attachmentsCheckedAt,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: 'LAUNCH_ATTACHMENT_STALE',
          lastErrorMessage: 'The approved venue QR is no longer current or failed integrity checks',
          lastErrorRetryable: false,
        },
      })
      if (stopped.count !== 1) return false
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: {
          status: 'CANCELLED',
          lastErrorCode: 'LAUNCH_ATTACHMENT_STALE',
          lastErrorMessage: 'The approved venue QR is no longer current or failed integrity checks',
        },
      })
      terminalBatchId = sendItem.batchId
      return false
    }
    const replyExists = await prospectReplyExistsBeforeProvider(tx, sendItem)
    const replyCheckedAt = input.now ?? new Date()
    // A slow reply lookup must not return permission to dispatch after this lease expired.
    if (operation.claimExpiresAt <= replyCheckedAt) return false
    if (replyExists) {
      const ambiguous = operation.attemptCount > 1
      const replyCode = ambiguous
        ? 'REPLY_RECEIVED_AFTER_PRIOR_ATTEMPT'
        : 'REPLY_RECEIVED_BEFORE_PROVIDER'
      const replyMessage = ambiguous
        ? 'An inbound reply was recorded after a prior provider attempt; delivery outcome is ambiguous'
        : 'An inbound reply was recorded before provider delivery'
      const cancelled = await tx.prospectSendOutbox.updateMany({
        where: {
          id: operation.id,
          status: 'CLAIMED',
          claimOwner: input.workerId,
          claimExpiresAt: { equals: operation.claimExpiresAt, gt: replyCheckedAt },
        },
        data: {
          status: ambiguous ? 'AMBIGUOUS' : 'CANCELLED',
          terminalAt: now,
          claimOwner: null,
          claimExpiresAt: null,
          lastErrorCode: replyCode,
          lastErrorMessage: replyMessage,
          lastErrorRetryable: false,
          ambiguousSince: ambiguous ? now : null,
        },
      })
      if (cancelled.count !== 1) return false
      await tx.prospectSendItem.update({
        where: { id: sendItem.id },
        data: { status: ambiguous ? 'AMBIGUOUS' : 'CANCELLED', lastErrorCode: replyCode },
      })
      terminalBatchId = sendItem.batchId
      return false
    }
    return true
  })
  if (terminalBatchId) await finalizeProspectSendBatch(terminalBatchId, client)
  return allowed
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
        ambiguousSince: input.acceptanceAmbiguous ? (operation.ambiguousSince ?? now) : null,
        terminalAt:
          input.acceptanceAmbiguous &&
          operation.attemptCount < MAX_PROSPECT_SEND_RECONCILIATION_ATTEMPTS
            ? null
            : input.retryable
              ? null
              : now,
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
