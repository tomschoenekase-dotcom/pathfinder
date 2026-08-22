import { db } from '../client'
import { foldProspectEmailStatus } from './prospect-send-outbox-actions'

type Client = typeof db
type DeliveryProjection =
  | 'STAGED'
  | 'QUEUED'
  | 'SENT'
  | 'DELAYED'
  | 'DELIVERED'
  | 'BOUNCED'
  | 'COMPLAINED'
  | 'SUPPRESSED'
  | 'FAILED'

const PROJECTABLE = new Set<DeliveryProjection>([
  'STAGED',
  'QUEUED',
  'SENT',
  'DELAYED',
  'DELIVERED',
  'BOUNCED',
  'COMPLAINED',
  'SUPPRESSED',
  'FAILED',
])

function json(value: unknown): object | unknown[] {
  return JSON.parse(JSON.stringify(value)) as object | unknown[]
}

export class ProspectEmailEventError extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectEmailEventError'
  }
}

/** Applies a provider-verified event idempotently and never regresses the canonical projection. */
export async function applyVerifiedProspectEmailEventAction(
  input: {
    providerAccountId: string
    providerEventId: string
    sendItemId: string
    eventType: 'DELIVERED' | 'DELAYED' | 'BOUNCED' | 'COMPLAINED'
    occurredAt: Date
    payload?: unknown
  },
  client: Client = db,
) {
  if (!input.providerEventId.trim() || input.providerEventId.length > 191) {
    throw new ProspectEmailEventError(
      'INVALID_INPUT',
      'A bounded provider event identity is required',
    )
  }
  return client.$transaction(async (tx) => {
    const item = await tx.prospectSendItem.findUnique({
      where: { id: input.sendItemId },
      include: { message: true, providerAccount: true, member: { include: { contact: true } } },
    })
    if (!item) throw new ProspectEmailEventError('NOT_FOUND', 'Prospect send item not found')
    if (item.providerAccountId !== input.providerAccountId) {
      throw new ProspectEmailEventError('CONFLICT', 'Provider event account does not own this send')
    }
    const event = await tx.prospectEmailEvent.upsert({
      where: {
        providerAccountId_providerEventId: {
          providerAccountId: input.providerAccountId,
          providerEventId: input.providerEventId,
        },
      },
      create: {
        sendItemId: item.id,
        emailMessageId: item.message?.id ?? null,
        providerAccountId: input.providerAccountId,
        providerEventId: input.providerEventId,
        eventType: input.eventType,
        occurredAt: input.occurredAt,
        payload: json(input.payload ?? {}),
      },
      update: {},
    })
    if (!PROJECTABLE.has(item.status as DeliveryProjection)) {
      return { event, status: item.status }
    }
    const next = foldProspectEmailStatus(
      item.status as DeliveryProjection,
      input.eventType,
    ) as DeliveryProjection
    if (next === item.status) return { event, status: item.status }

    await tx.prospectSendItem.update({ where: { id: item.id }, data: { status: next } })
    if (item.message) {
      await tx.prospectEmailMessage.update({
        where: { id: item.message.id },
        data: { status: next },
      })
    }
    if ((next === 'BOUNCED' || next === 'COMPLAINED') && item.member.contact) {
      const reasonCode = next === 'BOUNCED' ? 'PROVIDER_HARD_BOUNCE' : 'PROVIDER_COMPLAINT'
      await tx.prospectContact.update({
        where: { id: item.member.contact.id },
        data: {
          doNotContact: true,
          suppressedAt: input.occurredAt,
          suppressionReason: reasonCode,
          emailReadiness: 'INVALID',
        },
      })
      await tx.prospectContactSuppressionEvent.create({
        data: {
          contactId: item.member.contact.id,
          eventType: next === 'BOUNCED' ? 'HARD_BOUNCE' : 'COMPLAINT',
          source: 'PROVIDER',
          reasonCode,
          provider: item.providerAccount?.provider ?? 'GMAIL',
          actorType: 'SYSTEM',
          actorId: 'system:prospect-correspondence',
          evidence: { providerEventId: input.providerEventId, sendItemId: item.id },
          occurredAt: input.occurredAt,
        },
      })
      await tx.prospectFollowup.updateMany({
        where: {
          organizationId: item.member.organizationId,
          status: { in: ['PENDING', 'READY_FOR_DRAFT'] },
        },
        data: {
          status: 'CANCELLED',
          cancelledAt: input.occurredAt,
          reason: `${reasonCode}:${input.providerEventId}`.slice(0, 1_000),
        },
      })
    }
    return { event, status: next }
  })
}
