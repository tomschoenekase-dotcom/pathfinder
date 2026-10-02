import { createHash } from 'node:crypto'

import { canTransitionSupportRequest } from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { withTenantIsolationBypass } from '../middleware/tenant-isolation'
import { writeAuditLogStrict } from './audit'
import { lockSupportRequest } from './support-request-lock'

/**
 * Inbound email reply linking for client notifications.
 *
 * A reply is attached to a support request only through strong identifiers that the platform
 * minted itself: the outbound RFC Message-ID (matched against In-Reply-To / References), the
 * Message-ID of a reply that was already linked, or the provider thread of a reply that was
 * already linked. Subject and sender are never a way to FIND a thread. The sender is only a
 * further condition on a thread that identifiers already found: it must be the exact verified
 * recipient the notification was sent to. The tenant, venue and request all come from the matched
 * outbound record. Anything unmatched, ambiguous, mismatched or oversized goes to a tenant-less
 * quarantine queue that stores identifiers and hashes only.
 *
 * Message content is untrusted data. Only a bounded plain-text preview is kept; it is never
 * interpreted, never becomes a support message authored by the client, and never answers a
 * question. Linking moves a request that was waiting on the client to review through the existing
 * transition graph and nothing further.
 */

export const CLIENT_INBOUND_MAX_TEXT_BYTES = 100_000
export const CLIENT_INBOUND_MAX_HTML_BYTES = 200_000
export const CLIENT_INBOUND_PREVIEW_CHARS = 500
export const CLIENT_INBOUND_MAX_REFERENCES = 50

const SYSTEM_ACTOR_ID = 'system:client-inbound-reply'
const MESSAGE_ID_PATTERN = /^<[^<>\s]{1,900}>$/u
const SAFE_ID_PATTERN = /^[\x21-\x7e]{1,191}$/u
const EMAIL_PATTERN = /^[^\s@<>]{1,200}@[^\s@<>]{1,200}$/u

export type ClientInboundQuarantineReason =
  | 'UNKNOWN_THREAD'
  | 'AMBIGUOUS_THREAD'
  | 'SENDER_MISMATCH'
  | 'OVERSIZED_MESSAGE'
  | 'INVALID_MESSAGE'

export type ClientInboundMatchEvidence = 'RFC_REFERENCE' | 'REPLY_CHAIN' | 'PROVIDER_THREAD'

/** The provider-neutral shape an ingestion boundary hands to the linker. */
export type ClientInboundEmailInput = {
  provider: string
  mailboxId: string
  providerMessageId: string
  providerThreadId: string | null
  rfcMessageId: string | null
  inReplyTo: string | null
  references: readonly string[]
  fromAddress: string
  bodyText: string
  htmlBytes: number
  /** True when the provider already truncated the body to its own bound. */
  bodyTruncated: boolean
  receivedAt: Date
}

export type ClientInboundLinkResult =
  | {
      state: 'LINKED'
      replyId: string
      tenantId: string
      supportRequestId: string
      requestEffect: 'MOVED_TO_IN_REVIEW' | 'NO_CHANGE'
      evidence: ClientInboundMatchEvidence[]
    }
  | { state: 'QUARANTINED'; reason: ClientInboundQuarantineReason; quarantineId: string }
  | { state: 'DUPLICATE'; disposition: 'LINKED' | 'QUARANTINED' }
  /** Only with `quarantineUnknown: false`: no identifier matched, and nothing was recorded. */
  | { state: 'UNMATCHED' }

export type LinkInboundClientReplyOptions = {
  /**
   * When another matcher (the prospect thread matcher) runs after this one, an unmatched message
   * is handed back untouched instead of quarantined here. Default true.
   */
  quarantineUnknown?: boolean
}

export class ClientInboundReplyError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT',
    message: string,
  ) {
    super(message)
    this.name = 'ClientInboundReplyError'
  }
}

type Client = Pick<typeof db, '$transaction' | 'clientInboundQuarantine'>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

function isUniqueConflict(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002',
  )
}

export function normalizeInboundSenderAddress(value: string): string | null {
  const trimmed = value.trim().toLowerCase()
  return EMAIL_PATTERN.test(trimmed) ? trimmed : null
}

export function hashInboundSender(address: string): string {
  return sha256(`pathfinder-client-inbound-sender-v1:${address.trim().toLowerCase()}`)
}

/** A bounded, single-line, control-free preview of the new text only (quoted history dropped). */
export function boundedInboundPreview(text: string): string {
  const lines = text.split(/\r?\n/u)
  const fresh: string[] = []
  for (const line of lines) {
    if (/^\s*>/u.test(line)) continue
    if (/^\s*On .{1,200}wrote:\s*$/iu.test(line)) break
    if (/^\s*-{2,}\s*Original Message\s*-{2,}/iu.test(line)) break
    fresh.push(line)
    if (fresh.join(' ').length > CLIENT_INBOUND_PREVIEW_CHARS * 2) break
  }
  return (
    fresh
      .join(' ')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, CLIENT_INBOUND_PREVIEW_CHARS)
  )
}

/** In-Reply-To then References, valid message ids only, deduplicated, newest ancestors kept. */
export function candidateMessageIds(input: {
  inReplyTo: string | null
  references: readonly string[]
}): string[] {
  const seen = new Set<string>()
  for (const value of [
    input.inReplyTo,
    ...input.references.slice(-CLIENT_INBOUND_MAX_REFERENCES),
  ]) {
    const trimmed = value?.trim()
    if (trimmed && MESSAGE_ID_PATTERN.test(trimmed)) seen.add(trimmed)
  }
  return [...seen].slice(0, CLIENT_INBOUND_MAX_REFERENCES + 1)
}

type Candidate = {
  tenantId: string
  venueId: string
  supportRequestId: string
  intentId: string
  recipientEmail: string | null
  evidence: Set<ClientInboundMatchEvidence>
}

type Resolution =
  | { kind: 'DUPLICATE'; disposition: 'LINKED' | 'QUARANTINED' }
  | { kind: 'CANDIDATES'; candidates: Candidate[] }

/**
 * The single deliberate cross-tenant read: the owning tenant of an outbound anchor is not known
 * until the anchor is resolved, and the anchor is an unguessable platform-minted identifier. It
 * selects identifiers only. Every write afterwards is bound to the resolved tenant explicitly.
 */
async function resolveAnchors(input: ClientInboundEmailInput): Promise<Resolution> {
  return withTenantIsolationBypass(async () => {
    const existingReply = await db.clientInboundReply.findFirst({
      where: {
        provider: input.provider,
        mailboxId: input.mailboxId,
        providerMessageId: input.providerMessageId,
      },
      select: { id: true },
    })
    if (existingReply) return { kind: 'DUPLICATE', disposition: 'LINKED' } as const
    const existingQuarantine = await db.clientInboundQuarantine.findFirst({
      where: {
        provider: input.provider,
        mailboxId: input.mailboxId,
        providerMessageId: input.providerMessageId,
      },
      select: { id: true },
    })
    if (existingQuarantine) return { kind: 'DUPLICATE', disposition: 'QUARANTINED' } as const

    const ids = candidateMessageIds(input)
    const replySelect = {
      tenantId: true,
      venueId: true,
      supportRequestId: true,
      intentId: true,
      intent: { select: { recipientEmail: true } },
    } as const
    const [intents, chained, threaded] = await Promise.all([
      ids.length === 0
        ? Promise.resolve([])
        : db.clientNotificationIntent.findMany({
            where: { emailRfcMessageId: { in: ids } },
            take: 20,
            select: {
              id: true,
              tenantId: true,
              venueId: true,
              supportRequestId: true,
              recipientEmail: true,
            },
          }),
      ids.length === 0
        ? Promise.resolve([])
        : db.clientInboundReply.findMany({
            where: { rfcMessageId: { in: ids } },
            take: 20,
            select: replySelect,
          }),
      input.providerThreadId === null
        ? Promise.resolve([])
        : db.clientInboundReply.findMany({
            where: {
              provider: input.provider,
              mailboxId: input.mailboxId,
              providerThreadId: input.providerThreadId,
            },
            take: 20,
            select: replySelect,
          }),
    ])

    const byKey = new Map<string, Candidate>()
    const add = (
      row: {
        tenantId: string
        venueId: string
        supportRequestId: string
        intentId: string
        recipientEmail: string | null
      },
      evidence: ClientInboundMatchEvidence,
    ) => {
      const key = `${row.tenantId}\u0000${row.supportRequestId}\u0000${row.intentId}`
      const found = byKey.get(key)
      if (found) found.evidence.add(evidence)
      else byKey.set(key, { ...row, evidence: new Set([evidence]) })
    }
    for (const row of intents) add({ ...row, intentId: row.id }, 'RFC_REFERENCE')
    for (const row of chained)
      add({ ...row, recipientEmail: row.intent.recipientEmail }, 'REPLY_CHAIN')
    for (const row of threaded)
      add({ ...row, recipientEmail: row.intent.recipientEmail }, 'PROVIDER_THREAD')
    return { kind: 'CANDIDATES', candidates: [...byKey.values()] } as const
  })
}

type Quarantine = {
  reason: ClientInboundQuarantineReason
  candidateCount?: number
}

async function quarantine(
  client: Client,
  input: ClientInboundEmailInput,
  detail: Quarantine,
): Promise<ClientInboundLinkResult> {
  const sender = normalizeInboundSenderAddress(input.fromAddress)
  try {
    const row = await client.clientInboundQuarantine.create({
      data: {
        provider: input.provider,
        mailboxId: input.mailboxId,
        providerMessageId: input.providerMessageId,
        providerThreadId: input.providerThreadId,
        rfcMessageId:
          input.rfcMessageId && MESSAGE_ID_PATTERN.test(input.rfcMessageId)
            ? input.rfcMessageId
            : null,
        reason: detail.reason,
        candidateCount: detail.candidateCount ?? 0,
        senderHash: sender ? hashInboundSender(sender) : null,
        bodySha256: sha256(input.bodyText.slice(0, CLIENT_INBOUND_MAX_TEXT_BYTES)),
        bodyBytes: Math.min(Buffer.byteLength(input.bodyText, 'utf8'), 2_147_483_647),
        receivedAt: input.receivedAt,
      },
      select: { id: true },
    })
    return { state: 'QUARANTINED', reason: detail.reason, quarantineId: row.id }
  } catch (error) {
    if (isUniqueConflict(error)) return { state: 'DUPLICATE', disposition: 'QUARANTINED' }
    throw error
  }
}

function assertIdentifiers(input: ClientInboundEmailInput) {
  const bad =
    !/^[A-Z0-9_]{1,32}$/u.test(input.provider) ||
    !SAFE_ID_PATTERN.test(input.mailboxId) ||
    !SAFE_ID_PATTERN.test(input.providerMessageId) ||
    (input.providerThreadId !== null && !SAFE_ID_PATTERN.test(input.providerThreadId)) ||
    Number.isNaN(input.receivedAt.getTime())
  if (bad) throw new ClientInboundReplyError('INVALID_INPUT', 'Provider identifiers are invalid')
}

/**
 * Links one inbound message to the outbound client notification it answers, or quarantines it.
 * Idempotent on provider + mailbox + provider message id: a redelivery changes nothing.
 */
export async function linkInboundClientReply(
  input: ClientInboundEmailInput,
  client: Client = db,
  options: LinkInboundClientReplyOptions = {},
): Promise<ClientInboundLinkResult> {
  assertIdentifiers(input)

  const textBytes = Buffer.byteLength(input.bodyText, 'utf8')
  if (
    input.bodyTruncated ||
    textBytes > CLIENT_INBOUND_MAX_TEXT_BYTES ||
    input.htmlBytes > CLIENT_INBOUND_MAX_HTML_BYTES
  ) {
    return quarantine(client, input, { reason: 'OVERSIZED_MESSAGE' })
  }
  const sender = normalizeInboundSenderAddress(input.fromAddress)
  if (!sender) return quarantine(client, input, { reason: 'INVALID_MESSAGE' })

  const resolution = await resolveAnchors(input)
  if (resolution.kind === 'DUPLICATE')
    return { state: 'DUPLICATE', disposition: resolution.disposition }

  const requests = new Set(
    resolution.candidates.map(
      (candidate) => `${candidate.tenantId}\u0000${candidate.supportRequestId}`,
    ),
  )
  if (requests.size === 0)
    return options.quarantineUnknown === false
      ? { state: 'UNMATCHED' }
      : quarantine(client, input, { reason: 'UNKNOWN_THREAD' })
  if (requests.size > 1)
    return quarantine(client, input, { reason: 'AMBIGUOUS_THREAD', candidateCount: requests.size })

  // The thread is now fixed by identifiers. The sender must be the exact recipient it went to.
  const matching = resolution.candidates
    .filter((candidate) => candidate.recipientEmail?.trim().toLowerCase() === sender)
    .sort((left, right) => left.intentId.localeCompare(right.intentId))
  if (matching.length === 0)
    return quarantine(client, input, { reason: 'SENDER_MISMATCH', candidateCount: 1 })
  const target = matching[0]!
  const evidence = [...new Set(matching.flatMap((candidate) => [...candidate.evidence]))].sort()

  try {
    return await client.$transaction(async (tx) => {
      await lockSupportRequest(tx, target.tenantId, target.supportRequestId)
      const request = await tx.supportRequest.findFirst({
        where: {
          id: target.supportRequestId,
          tenantId: target.tenantId,
          venueId: target.venueId,
        },
        select: { id: true, status: true, version: true },
      })
      if (!request) return quarantine(client, input, { reason: 'UNKNOWN_THREAD' })

      const moves =
        request.status === 'WAITING_FOR_CLIENT' &&
        canTransitionSupportRequest('WAITING_FOR_CLIENT', 'IN_REVIEW')
      if (moves) {
        const nextVersion = request.version + 1
        const changed = await tx.supportRequest.updateMany({
          where: {
            id: request.id,
            tenantId: target.tenantId,
            venueId: target.venueId,
            version: request.version,
            status: 'WAITING_FOR_CLIENT',
          },
          data: {
            status: 'IN_REVIEW',
            statusChangedAt: new Date(),
            version: nextVersion,
            updatedByKind: 'SYSTEM',
            updatedById: SYSTEM_ACTOR_ID,
          },
        })
        if (changed.count !== 1) throw new Error('SUPPORT_REQUEST_CHANGED')
        await tx.supportRequestAuditEvent.create({
          data: {
            tenantId: target.tenantId,
            venueId: target.venueId,
            supportRequestId: request.id,
            requestVersion: nextVersion,
            eventType: 'INBOUND_EMAIL_REPLY_LINKED',
            actorKind: 'SYSTEM',
            actorId: SYSTEM_ACTOR_ID,
            fromStatus: 'WAITING_FOR_CLIENT',
            toStatus: 'IN_REVIEW',
          },
          select: { id: true },
        })
      }
      const requestEffect = moves ? ('MOVED_TO_IN_REVIEW' as const) : ('NO_CHANGE' as const)

      const reply = await tx.clientInboundReply.create({
        data: {
          tenantId: target.tenantId,
          venueId: target.venueId,
          supportRequestId: target.supportRequestId,
          intentId: target.intentId,
          provider: input.provider,
          mailboxId: input.mailboxId,
          providerMessageId: input.providerMessageId,
          providerThreadId: input.providerThreadId,
          rfcMessageId:
            input.rfcMessageId && MESSAGE_ID_PATTERN.test(input.rfcMessageId)
              ? input.rfcMessageId
              : null,
          inReplyTo:
            input.inReplyTo && MESSAGE_ID_PATTERN.test(input.inReplyTo.trim())
              ? input.inReplyTo.trim()
              : null,
          matchEvidence: evidence,
          senderHash: hashInboundSender(sender),
          bodyPreview: boundedInboundPreview(input.bodyText),
          bodySha256: sha256(input.bodyText),
          bodyBytes: textBytes,
          requestEffect,
          receivedAt: input.receivedAt,
        },
        select: { id: true },
      })
      // IDs, states and sizes only: never the sender address, subject or any message text.
      await writeAuditLogStrict(
        {
          tenantId: target.tenantId,
          actorId: SYSTEM_ACTOR_ID,
          actorRole: 'SYSTEM',
          actorType: 'SYSTEM',
          action: 'client-inbound-reply.linked',
          targetType: 'SupportRequest',
          targetId: request.id,
          afterState: {
            replyId: reply.id,
            intentId: target.intentId,
            venueId: target.venueId,
            evidence,
            requestEffect,
            statusBefore: request.status,
            bodyBytes: textBytes,
          },
        },
        tx,
      )
      return {
        state: 'LINKED' as const,
        replyId: reply.id,
        tenantId: target.tenantId,
        supportRequestId: target.supportRequestId,
        requestEffect,
        evidence,
      }
    })
  } catch (error) {
    // A concurrent delivery of the same provider message won the unique key.
    if (isUniqueConflict(error)) return { state: 'DUPLICATE', disposition: 'LINKED' }
    throw error
  }
}
