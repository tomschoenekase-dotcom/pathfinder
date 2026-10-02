import { createHash, randomBytes } from 'node:crypto'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

/**
 * One durable notification intent per approved information request. The portal post is the
 * support message that already exists; the optional email goes to one exact verified recipient.
 * Content is frozen and hashed when the intent is created. Email delivery is a small state
 * machine with compare-and-swap transitions so a retry delivers only the failed channel and an
 * unknown outcome is never re-sent without a human reconciliation.
 */

type Transaction = Parameters<Parameters<typeof db.$transaction>[0]>[0]
type Client = Pick<typeof db, '$transaction'>

export const CLIENT_NOTIFICATION_KIND = 'INFORMATION_REQUEST' as const

export type ClientNotificationItem = {
  text: string
  why?: string
  effect?: string
  /** The canonical support conversation this item lives in. */
  requestId: string
  /** The blocking AgentQuestion this item asks, when it asks one. */
  questionId?: string
}

export type ClientNotificationContent = {
  version: 1
  subject: string
  intro: string
  items: ClientNotificationItem[]
}

export class ClientNotificationError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_INPUT' | 'DISABLED',
    message: string,
  ) {
    super(message)
    this.name = 'ClientNotificationError'
  }
}

/** Failure codes that retrying the same intent can never fix. */
export const CLIENT_NOTIFICATION_NON_RETRYABLE_CODES = [
  'NO_VERIFIED_EMAIL',
  'SUPERSEDED',
  'RECIPIENT_INACTIVE',
  'CONTENT_MISMATCH',
] as const

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`
}

const sha256 = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

export function clientNotificationContentHash(
  content: ClientNotificationContent,
  scope: { supportRequestId: string; requestVersion: number; recipientUserId: string },
): string {
  return sha256({ domain: 'pathfinder-client-notification-content-v1', content, ...scope })
}

export function clientNotificationIdempotencyKey(input: {
  tenantId: string
  supportRequestId: string
  requestVersion: number
  recipientUserId: string
  contentHash: string
}): string {
  return sha256({ domain: 'pathfinder-client-notification-intent-v1', ...input })
}

/**
 * A fresh outbound Message-ID. The random token makes it unguessable, which is what lets an
 * inbound reply that cites it be trusted to belong to this one notification.
 */
export function mintClientNotificationRfcMessageId(domain: string | undefined): string | null {
  if (!domain || !/^[a-z0-9]([a-z0-9.-]{0,198}[a-z0-9])?$/iu.test(domain)) return null
  return `<ci.${randomBytes(24).toString('hex')}@${domain.toLowerCase()}>`
}

/** The canonical customer-portal location of one support conversation. */
export function supportRequestPortalPath(venueId: string, requestId: string): string {
  return `/support?venue=${encodeURIComponent(venueId)}&request=${encodeURIComponent(requestId)}`
}

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002',
  )
}

const intentSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  supportRequestId: true,
  supportMessageId: true,
  requestVersion: true,
  questionIds: true,
  recipientUserId: true,
  contentHash: true,
  emailRequested: true,
  emailStatus: true,
  emailGeneration: true,
} as const

export type ClientNotificationIntentRef = {
  id: string
  tenantId: string
  venueId: string
  supportRequestId: string
  supportMessageId: string
  requestVersion: number
  questionIds: string[]
  recipientUserId: string
  contentHash: string
  emailRequested: boolean
  emailStatus: 'QUEUED' | 'SENDING' | 'SENT' | 'FAILED' | 'UNKNOWN' | null
  emailGeneration: number
}

export type CreateClientNotificationIntentInput = {
  tenantId: string
  venueId: string
  supportRequestId: string
  supportMessageId: string
  requestVersion: number
  questionIds: string[]
  recipientUserId: string
  /** The identity provider's verified address for the recipient, or null when there is none. */
  recipientEmail: string | null
  /** Whether the operator wants an email as well as the portal post. */
  emailRequested: boolean
  /** The deployment's email switch, read by the caller; false never queues a send. */
  emailEnabled: boolean
  content: ClientNotificationContent
  actor: { actorId: string; auditRole: string }
}

/**
 * Creates the one intent for an applied request inside the caller's transaction, with its
 * portal receipt and the initial email receipt. Replays return the existing intent unchanged.
 */
export async function createClientNotificationIntent(
  tx: Transaction,
  input: CreateClientNotificationIntentInput,
): Promise<{ intent: ClientNotificationIntentRef; created: boolean }> {
  if (input.content.items.length === 0 || input.content.items.length > 30) {
    throw new ClientNotificationError('INVALID_INPUT', 'A notification needs 1 to 30 items')
  }
  const membership = await tx.tenantMembership.findFirst({
    where: { tenantId: input.tenantId, userId: input.recipientUserId, status: 'ACTIVE' },
    select: { id: true },
  })
  if (!membership) throw new ClientNotificationError('NOT_FOUND', 'Recipient is not available')

  const contentHash = clientNotificationContentHash(input.content, {
    supportRequestId: input.supportRequestId,
    requestVersion: input.requestVersion,
    recipientUserId: input.recipientUserId,
  })
  const idempotencyKey = clientNotificationIdempotencyKey({
    tenantId: input.tenantId,
    supportRequestId: input.supportRequestId,
    requestVersion: input.requestVersion,
    recipientUserId: input.recipientUserId,
    contentHash,
  })
  const existing = await tx.clientNotificationIntent.findFirst({
    where: { tenantId: input.tenantId, idempotencyKey },
    select: intentSelect,
  })
  if (existing) return { intent: existing, created: false }

  const email = !input.emailRequested
    ? null
    : !input.recipientEmail
      ? ({ status: 'FAILED', errorCode: 'NO_VERIFIED_EMAIL' } as const)
      : !input.emailEnabled
        ? ({ status: 'FAILED', errorCode: 'EMAIL_DELIVERY_DISABLED' } as const)
        : ({ status: 'QUEUED', errorCode: null } as const)

  const intent = await tx.clientNotificationIntent.create({
    data: {
      tenantId: input.tenantId,
      venueId: input.venueId,
      supportRequestId: input.supportRequestId,
      supportMessageId: input.supportMessageId,
      kind: CLIENT_NOTIFICATION_KIND,
      requestVersion: input.requestVersion,
      questionIds: input.questionIds,
      recipientUserId: input.recipientUserId,
      recipientEmail: input.emailRequested ? input.recipientEmail : null,
      contentSnapshot: input.content as unknown as object,
      contentHash,
      idempotencyKey,
      createdBy: input.actor.actorId,
      emailRequested: input.emailRequested,
      emailStatus: email?.status ?? null,
      emailGeneration: email?.status === 'QUEUED' ? 1 : 0,
      emailLastErrorCode: email?.errorCode ?? null,
    },
    select: intentSelect,
  })
  await tx.clientNotificationReceipt.create({
    data: {
      tenantId: input.tenantId,
      intentId: intent.id,
      channel: 'PORTAL',
      status: 'PORTAL_POSTED',
      generation: 0,
      actorId: input.actor.actorId,
    },
    select: { id: true },
  })
  if (email) {
    await tx.clientNotificationReceipt.create({
      data: {
        tenantId: input.tenantId,
        intentId: intent.id,
        channel: 'EMAIL',
        status: email.status === 'QUEUED' ? 'EMAIL_QUEUED' : 'EMAIL_FAILED',
        generation: intent.emailGeneration,
        errorCode: email.errorCode,
        actorId: input.actor.actorId,
      },
      select: { id: true },
    })
  }
  // IDs and states only: never the recipient address or any question text.
  await writeAuditLogStrict(
    {
      tenantId: input.tenantId,
      actorId: input.actor.actorId,
      actorRole: input.actor.auditRole,
      action: 'client-notification.intent-created',
      targetType: 'ClientNotificationIntent',
      targetId: intent.id,
      afterState: {
        venueId: input.venueId,
        supportRequestId: input.supportRequestId,
        requestVersion: input.requestVersion,
        questionCount: input.questionIds.length,
        recipientUserId: input.recipientUserId,
        contentHash,
        portalPosted: true,
        emailStatus: email?.status ?? null,
        emailErrorCode: email?.errorCode ?? null,
      },
    },
    tx,
  )
  return { intent, created: true }
}

/** Same as createClientNotificationIntent for a caller with no transaction of its own. */
export async function createClientNotificationIntentAction(
  input: CreateClientNotificationIntentInput,
  client: Client = db,
) {
  try {
    return await client.$transaction((tx) => createClientNotificationIntent(tx, input))
  } catch (error) {
    if (!isUniqueConflict(error)) throw error
    return client.$transaction((tx) => createClientNotificationIntent(tx, input))
  }
}

// ---------------------------------------------------------------------------
// Email delivery
// ---------------------------------------------------------------------------

export type ClientNotificationSkipReason =
  | 'NOT_FOUND'
  | 'STALE_GENERATION'
  | 'NOT_QUEUED'
  | 'ALREADY_SENT'
  | 'UNKNOWN_NEEDS_RECONCILIATION'
  | 'SUPERSEDED'
  | 'RECIPIENT_INACTIVE'
  | 'CONTENT_MISMATCH'

export type ClientNotificationDeliveryDecision =
  | {
      action: 'send'
      intentId: string
      generation: number
      venueId: string
      to: string
      /** The Message-ID this send must carry so a reply can be linked back; null when unavailable. */
      rfcMessageId: string | null
      content: ClientNotificationContent
      /** Items whose question and conversation are still open; closed ones are not re-asked. */
      openItems: ClientNotificationItem[]
    }
  | { action: 'skip'; reason: ClientNotificationSkipReason }

async function appendEmailReceipt(
  tx: Transaction,
  intent: { tenantId: string; id: string },
  status: 'EMAIL_QUEUED' | 'EMAIL_SENT' | 'EMAIL_FAILED' | 'EMAIL_UNKNOWN',
  generation: number,
  extra: {
    errorCode?: string | null
    providerMessageId?: string | null
    actorId?: string | null
  } = {},
) {
  await tx.clientNotificationReceipt.create({
    data: {
      tenantId: intent.tenantId,
      intentId: intent.id,
      channel: 'EMAIL',
      status,
      generation,
      errorCode: extra.errorCode ?? null,
      providerMessageId: extra.providerMessageId ?? null,
      actorId: extra.actorId ?? null,
    },
    select: { id: true },
  })
}

async function closeEmail(
  tx: Transaction,
  intent: { tenantId: string; id: string; emailGeneration: number },
  from: ('QUEUED' | 'SENDING' | 'UNKNOWN')[],
  errorCode: string,
) {
  const changed = await tx.clientNotificationIntent.updateMany({
    where: {
      id: intent.id,
      tenantId: intent.tenantId,
      emailGeneration: intent.emailGeneration,
      emailStatus: { in: from },
    },
    data: { emailStatus: 'FAILED', emailLastErrorCode: errorCode },
  })
  if (changed.count === 1)
    await appendEmailReceipt(tx, intent, 'EMAIL_FAILED', intent.emailGeneration, { errorCode })
}

/**
 * Claims one queued email for sending and decides, from current canonical state, whether it
 * should still go out. Everything happens in one transaction: either the intent is SENDING and
 * the caller holds the only claim, or it is closed with a reason and nothing is sent.
 */
export async function beginClientNotificationEmailDelivery(
  input: {
    tenantId: string
    intentId: string
    generation: number
    /** Sending domain for the minted Message-ID. Without it no anchor is minted. */
    messageIdDomain?: string
  },
  client: Client = db,
): Promise<ClientNotificationDeliveryDecision> {
  return client.$transaction(async (tx) => {
    const intent = await tx.clientNotificationIntent.findFirst({
      where: { id: input.intentId, tenantId: input.tenantId },
      select: {
        ...intentSelect,
        recipientEmail: true,
        contentSnapshot: true,
        createdAt: true,
        emailLastErrorCode: true,
      },
    })
    if (!intent || !intent.emailRequested) return { action: 'skip', reason: 'NOT_FOUND' }
    if (intent.emailGeneration !== input.generation)
      return { action: 'skip', reason: 'STALE_GENERATION' }
    if (intent.emailStatus === 'SENT') return { action: 'skip', reason: 'ALREADY_SENT' }
    if (intent.emailStatus === 'UNKNOWN')
      return { action: 'skip', reason: 'UNKNOWN_NEEDS_RECONCILIATION' }
    if (intent.emailStatus === 'SENDING') {
      // A previous attempt claimed this and never reported. The provider may have accepted it,
      // so this is unknown, never "try again".
      const changed = await tx.clientNotificationIntent.updateMany({
        where: {
          id: intent.id,
          tenantId: intent.tenantId,
          emailGeneration: intent.emailGeneration,
          emailStatus: 'SENDING',
        },
        data: { emailStatus: 'UNKNOWN', emailLastErrorCode: 'ATTEMPT_INTERRUPTED' },
      })
      if (changed.count === 1)
        await appendEmailReceipt(tx, intent, 'EMAIL_UNKNOWN', intent.emailGeneration, {
          errorCode: 'ATTEMPT_INTERRUPTED',
        })
      return { action: 'skip', reason: 'UNKNOWN_NEEDS_RECONCILIATION' }
    }
    if (intent.emailStatus !== 'QUEUED') return { action: 'skip', reason: 'NOT_QUEUED' }

    const content = intent.contentSnapshot as unknown as ClientNotificationContent
    const expectedHash = clientNotificationContentHash(content, {
      supportRequestId: intent.supportRequestId,
      requestVersion: intent.requestVersion,
      recipientUserId: intent.recipientUserId,
    })
    if (expectedHash !== intent.contentHash || !intent.recipientEmail) {
      await closeEmail(
        tx,
        intent,
        ['QUEUED'],
        !intent.recipientEmail ? 'NO_VERIFIED_EMAIL' : 'CONTENT_MISMATCH',
      )
      return {
        action: 'skip',
        reason: !intent.recipientEmail ? 'NOT_QUEUED' : 'CONTENT_MISMATCH',
      }
    }

    const member = await tx.tenantMembership.findFirst({
      where: { tenantId: intent.tenantId, userId: intent.recipientUserId, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!member) {
      await closeEmail(tx, intent, ['QUEUED'], 'RECIPIENT_INACTIVE')
      return { action: 'skip', reason: 'RECIPIENT_INACTIVE' }
    }

    const openItems = await openNotificationItems(tx, intent, content)
    if (openItems.length === 0) {
      // Answered, declined, expired or superseded: nothing is left to ask.
      await closeEmail(tx, intent, ['QUEUED'], 'SUPERSEDED')
      return { action: 'skip', reason: 'SUPERSEDED' }
    }

    const rfcMessageId = mintClientNotificationRfcMessageId(input.messageIdDomain)
    const claimed = await tx.clientNotificationIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: intent.tenantId,
        emailGeneration: input.generation,
        emailStatus: 'QUEUED',
      },
      data: {
        emailStatus: 'SENDING',
        emailAttemptCount: { increment: 1 },
        ...(rfcMessageId ? { emailRfcMessageId: rfcMessageId } : {}),
      },
    })
    if (claimed.count !== 1) return { action: 'skip', reason: 'NOT_QUEUED' }
    return {
      action: 'send',
      intentId: intent.id,
      generation: intent.emailGeneration,
      venueId: intent.venueId,
      to: intent.recipientEmail,
      rfcMessageId,
      content,
      openItems,
    }
  })
}

/** Items whose conversation is still waiting on the customer and whose question is still open. */
async function openNotificationItems(
  tx: Transaction,
  intent: { tenantId: string; venueId: string; createdAt: Date },
  content: ClientNotificationContent,
): Promise<ClientNotificationItem[]> {
  const requestIds = [...new Set(content.items.map((item) => item.requestId))]
  const questionIds = [
    ...new Set(content.items.flatMap((item) => (item.questionId ? [item.questionId] : []))),
  ]
  const [requests, answers, questions] = await Promise.all([
    tx.supportRequest.findMany({
      where: { tenantId: intent.tenantId, venueId: intent.venueId, id: { in: requestIds } },
      select: { id: true, status: true },
    }),
    tx.supportMessage.findMany({
      where: {
        tenantId: intent.tenantId,
        venueId: intent.venueId,
        supportRequestId: { in: requestIds },
        authorKind: 'CLIENT',
        createdAt: { gt: intent.createdAt },
      },
      select: { supportRequestId: true },
    }),
    questionIds.length === 0
      ? Promise.resolve([] as { id: string; status: string }[])
      : tx.agentQuestion.findMany({
          where: { tenantId: intent.tenantId, venueId: intent.venueId, id: { in: questionIds } },
          select: { id: true, status: true },
        }),
  ])
  const requestOpen = new Set(
    requests
      .filter((request) => request.status === 'OPEN' || request.status === 'WAITING_FOR_CLIENT')
      .map((request) => request.id),
  )
  const answered = new Set(answers.map((message) => message.supportRequestId))
  const questionOpen = new Set(
    questions.filter((question) => question.status === 'PENDING').map((question) => question.id),
  )
  return content.items.filter(
    (item) =>
      requestOpen.has(item.requestId) &&
      !answered.has(item.requestId) &&
      (item.questionId === undefined || questionOpen.has(item.questionId)),
  )
}

export type ClientNotificationEmailOutcome =
  | { kind: 'sent'; providerMessageId?: string | null }
  | { kind: 'failed'; errorCode: string }
  | { kind: 'unknown'; errorCode: string }

/** Records what the provider call did. Only the holder of the SENDING claim may call this. */
export async function completeClientNotificationEmailDelivery(
  input: {
    tenantId: string
    intentId: string
    generation: number
    outcome: ClientNotificationEmailOutcome
  },
  client: Client = db,
): Promise<{ recorded: boolean }> {
  return client.$transaction(async (tx) => {
    const { tenantId, intentId, generation, outcome } = input
    const where = {
      id: intentId,
      tenantId,
      emailGeneration: generation,
      emailStatus: {
        in:
          outcome.kind === 'sent' ? ['SENDING' as const, 'UNKNOWN' as const] : ['SENDING' as const],
      },
    }
    const data =
      outcome.kind === 'sent'
        ? {
            emailStatus: 'SENT' as const,
            emailSentAt: new Date(),
            emailProviderMessageId: outcome.providerMessageId ?? null,
            emailLastErrorCode: null,
          }
        : {
            emailStatus: outcome.kind === 'failed' ? ('FAILED' as const) : ('UNKNOWN' as const),
            emailLastErrorCode: outcome.errorCode,
          }
    const changed = await tx.clientNotificationIntent.updateMany({ where, data })
    if (changed.count !== 1) return { recorded: false }
    await appendEmailReceipt(
      tx,
      { tenantId, id: intentId },
      outcome.kind === 'sent'
        ? 'EMAIL_SENT'
        : outcome.kind === 'failed'
          ? 'EMAIL_FAILED'
          : 'EMAIL_UNKNOWN',
      generation,
      outcome.kind === 'sent'
        ? { providerMessageId: outcome.providerMessageId ?? null }
        : { errorCode: outcome.errorCode },
    )
    return { recorded: true }
  })
}

/**
 * Closes a still-queued email as not sent, with a reason, before any provider call was made:
 * the deployment's switch or provider is not ready, or the job never reached the queue. Nothing
 * was attempted, so the same email may be queued again once the cause is fixed.
 */
export async function failQueuedClientNotificationEmail(
  input: { tenantId: string; intentId: string; generation: number; errorCode: string },
  client: Client = db,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const intent = await tx.clientNotificationIntent.findFirst({
      where: { id: input.intentId, tenantId: input.tenantId },
      select: { id: true, tenantId: true, emailGeneration: true },
    })
    if (!intent || intent.emailGeneration !== input.generation) return
    await closeEmail(tx, intent, ['QUEUED'], input.errorCode)
  })
}

/** The job never reached the queue: the email did not go out and may be queued again. */
export function markClientNotificationEnqueueFailed(
  input: { tenantId: string; intentId: string; generation: number },
  client: Client = db,
): Promise<void> {
  return failQueuedClientNotificationEmail({ ...input, errorCode: 'ENQUEUE_FAILED' }, client)
}

/**
 * Queues only the failed email channel again, under a new generation so the old job cannot act.
 * The portal post is never repeated. A sent, unknown, in-flight or permanently refused email is
 * not requeued, and nothing is queued while the deployment's email switch is off.
 */
export async function requeueClientNotificationEmail(
  input: { tenantId: string; intentId: string; actorId: string; emailEnabled: boolean },
  client: Client = db,
): Promise<{ intentId: string; generation: number }> {
  if (!input.emailEnabled)
    throw new ClientNotificationError('DISABLED', 'Client notification email is not enabled')
  return client.$transaction(async (tx) => {
    const intent = await tx.clientNotificationIntent.findFirst({
      where: { id: input.intentId, tenantId: input.tenantId },
      select: {
        id: true,
        tenantId: true,
        emailStatus: true,
        emailGeneration: true,
        emailLastErrorCode: true,
        recipientEmail: true,
      },
    })
    if (!intent) throw new ClientNotificationError('NOT_FOUND', 'Notification not found')
    if (
      intent.emailStatus !== 'FAILED' ||
      !intent.recipientEmail ||
      (CLIENT_NOTIFICATION_NON_RETRYABLE_CODES as readonly string[]).includes(
        intent.emailLastErrorCode ?? '',
      )
    )
      throw new ClientNotificationError('CONFLICT', 'This email cannot be queued again')
    const generation = intent.emailGeneration + 1
    const changed = await tx.clientNotificationIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: intent.tenantId,
        emailStatus: 'FAILED',
        emailGeneration: intent.emailGeneration,
      },
      data: { emailStatus: 'QUEUED', emailGeneration: generation, emailLastErrorCode: null },
    })
    if (changed.count !== 1)
      throw new ClientNotificationError('CONFLICT', 'This email cannot be queued again')
    await appendEmailReceipt(tx, intent, 'EMAIL_QUEUED', generation, { actorId: input.actorId })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'client-notification.email-requeued',
        targetType: 'ClientNotificationIntent',
        targetId: intent.id,
        afterState: { generation, portalReposted: false },
      },
      tx,
    )
    return { intentId: intent.id, generation }
  })
}

/**
 * A person confirmed, from the provider's own records, what an UNKNOWN email actually did.
 * `SENT` closes it as delivered; `NOT_SENT` returns it to a retryable failure.
 */
export async function reconcileClientNotificationEmail(
  input: {
    tenantId: string
    intentId: string
    actorId: string
    outcome: 'SENT' | 'NOT_SENT'
    providerMessageId?: string
  },
  client: Client = db,
): Promise<void> {
  await client.$transaction(async (tx) => {
    const intent = await tx.clientNotificationIntent.findFirst({
      where: { id: input.intentId, tenantId: input.tenantId },
      select: { id: true, tenantId: true, emailStatus: true, emailGeneration: true },
    })
    if (!intent) throw new ClientNotificationError('NOT_FOUND', 'Notification not found')
    if (intent.emailStatus !== 'UNKNOWN')
      throw new ClientNotificationError('CONFLICT', 'Only an unknown email outcome is reconciled')
    const sent = input.outcome === 'SENT'
    const changed = await tx.clientNotificationIntent.updateMany({
      where: {
        id: intent.id,
        tenantId: intent.tenantId,
        emailStatus: 'UNKNOWN',
        emailGeneration: intent.emailGeneration,
      },
      data: sent
        ? {
            emailStatus: 'SENT',
            emailSentAt: new Date(),
            emailProviderMessageId: input.providerMessageId ?? null,
            emailLastErrorCode: null,
          }
        : { emailStatus: 'FAILED', emailLastErrorCode: 'RECONCILED_NOT_SENT' },
    })
    if (changed.count !== 1)
      throw new ClientNotificationError('CONFLICT', 'Only an unknown email outcome is reconciled')
    await appendEmailReceipt(
      tx,
      intent,
      sent ? 'EMAIL_SENT' : 'EMAIL_FAILED',
      intent.emailGeneration,
      {
        ...(sent
          ? { providerMessageId: input.providerMessageId ?? null }
          : { errorCode: 'RECONCILED_NOT_SENT' }),
        actorId: input.actorId,
      },
    )
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actorId,
        actorRole: 'PLATFORM_ADMIN',
        action: 'client-notification.email-reconciled',
        targetType: 'ClientNotificationIntent',
        targetId: intent.id,
        afterState: { outcome: input.outcome },
      },
      tx,
    )
  })
}
