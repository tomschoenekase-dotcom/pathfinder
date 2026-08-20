import { db } from '../client'
import { writeAuditLogStrict } from './audit'

type Client = typeof db
type ContactabilityActor =
  | { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
  | { type: 'SYSTEM'; id: string; role: 'SYSTEM' }

export class ProspectContactabilityError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID_INPUT' | 'APPROVAL_REQUIRED',
    message: string,
  ) {
    super(message)
    this.name = 'ProspectContactabilityError'
  }
}

/** A human review is the only path from imported/unknown email data to send eligibility. */
export async function reviewProspectContactReadinessAction(
  input: {
    contactId: string
    emailReadiness: 'UNKNOWN' | 'REVIEW_REQUIRED' | 'VALID' | 'INVALID'
    permissionState: 'UNKNOWN' | 'REVIEW_REQUIRED' | 'LEGITIMATE_INTEREST_RECORDED' | 'OPTED_IN'
    evidence: Record<string, unknown>
    actor: { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
  },
  client: Client = db,
) {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectContactabilityError('APPROVAL_REQUIRED', 'Human contact review is required')
  }
  if (Object.keys(input.evidence).length === 0) {
    throw new ProspectContactabilityError('INVALID_INPUT', 'Contact review evidence is required')
  }
  return client.$transaction(async (tx) => {
    const contact = await tx.prospectContact.findUnique({ where: { id: input.contactId } })
    if (!contact) throw new ProspectContactabilityError('NOT_FOUND', 'Prospect contact not found')
    if (contact.doNotContact || contact.suppressedAt || contact.unsubscribedAt) {
      throw new ProspectContactabilityError(
        'APPROVAL_REQUIRED',
        'Suppressed contactability must use the separately audited restoration action',
      )
    }
    const saved = await tx.prospectContact.update({
      where: { id: contact.id },
      data: {
        emailReadiness: input.emailReadiness,
        permissionState: input.permissionState,
        permissionEvidence: input.evidence,
        updatedBy: input.actor.id,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.contactability.review',
        targetType: 'ProspectContact',
        targetId: contact.id,
        beforeState: {
          emailReadiness: contact.emailReadiness,
          permissionState: contact.permissionState,
        },
        afterState: {
          emailReadiness: saved.emailReadiness,
          permissionState: saved.permissionState,
          evidence: input.evidence,
        },
      },
      tx,
    )
    return saved
  })
}

export async function recordProspectSuppressionAction(
  input: {
    contactId: string
    eventType: 'SUPPRESSED' | 'UNSUBSCRIBED' | 'HARD_BOUNCE' | 'SOFT_BOUNCE' | 'COMPLAINT'
    source: 'HUMAN' | 'IMPORT' | 'PROVIDER' | 'INBOUND_MESSAGE' | 'POLICY' | 'SYSTEM'
    reasonCode: string
    reason?: string
    provider?: 'GMAIL' | 'RESEND' | 'FAKE'
    evidence?: Record<string, unknown>
    actor: ContactabilityActor
  },
  client: Client = db,
) {
  if (!input.actor.id || !input.reasonCode.trim()) {
    throw new ProspectContactabilityError('INVALID_INPUT', 'Actor and reason code are required')
  }
  return client.$transaction(async (tx) => {
    const contact = await tx.prospectContact.findUnique({ where: { id: input.contactId } })
    if (!contact) throw new ProspectContactabilityError('NOT_FOUND', 'Prospect contact not found')
    const now = new Date()
    const terminalSuppression = ['SUPPRESSED', 'UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT'].includes(
      input.eventType,
    )
    const saved = await tx.prospectContact.update({
      where: { id: contact.id },
      data: {
        ...(terminalSuppression
          ? {
              doNotContact: true,
              suppressedAt: now,
              suppressionReason: input.reason?.trim() || input.reasonCode,
              permissionState: input.eventType === 'UNSUBSCRIBED' ? 'OPTED_OUT' : 'PROHIBITED',
            }
          : {}),
        ...(input.eventType === 'UNSUBSCRIBED' ? { unsubscribedAt: now } : {}),
        ...(input.eventType === 'COMPLAINT' ? { complainedAt: now } : {}),
        ...(input.eventType === 'HARD_BOUNCE' ? { lastHardBounceAt: now } : {}),
        ...(input.eventType === 'SOFT_BOUNCE' ? { lastSoftBounceAt: now } : {}),
        updatedBy: input.actor.id,
      },
    })
    const event = await tx.prospectContactSuppressionEvent.create({
      data: {
        contactId: contact.id,
        eventType: input.eventType,
        source: input.source,
        reasonCode: input.reasonCode.trim(),
        reason: input.reason?.trim() || null,
        provider: input.provider ?? null,
        actorType: input.actor.type,
        actorId: input.actor.id,
        evidence: input.evidence ?? {},
        occurredAt: now,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: `prospect.contactability.${input.eventType.toLowerCase()}`,
        targetType: 'ProspectContact',
        targetId: contact.id,
        beforeState: {
          doNotContact: contact.doNotContact,
          permissionState: contact.permissionState,
          suppressedAt: contact.suppressedAt?.toISOString() ?? null,
        },
        afterState: {
          doNotContact: saved.doNotContact,
          permissionState: saved.permissionState,
          suppressedAt: saved.suppressedAt?.toISOString() ?? null,
          eventId: event.id,
        },
      },
      tx,
    )
    return { contact: saved, event }
  })
}

/** Restoration is intentionally human-only and never erases suppression history. */
export async function restoreProspectContactabilityAction(
  input: {
    contactId: string
    reasonCode: string
    reason: string
    permissionState: 'UNKNOWN' | 'REVIEW_REQUIRED' | 'LEGITIMATE_INTEREST_RECORDED' | 'OPTED_IN'
    actor: { type: 'HUMAN'; id: string; role: 'PLATFORM_ADMIN' }
  },
  client: Client = db,
) {
  if (input.actor.type !== 'HUMAN' || input.actor.role !== 'PLATFORM_ADMIN') {
    throw new ProspectContactabilityError(
      'APPROVAL_REQUIRED',
      'A human platform administrator must review restoration',
    )
  }
  if (!input.reason.trim() || !input.reasonCode.trim()) {
    throw new ProspectContactabilityError('INVALID_INPUT', 'Restoration reason is required')
  }
  return client.$transaction(async (tx) => {
    const contact = await tx.prospectContact.findUnique({ where: { id: input.contactId } })
    if (!contact) throw new ProspectContactabilityError('NOT_FOUND', 'Prospect contact not found')
    const now = new Date()
    const saved = await tx.prospectContact.update({
      where: { id: contact.id },
      data: {
        doNotContact: false,
        suppressedAt: null,
        suppressionReason: null,
        permissionState: input.permissionState,
        updatedBy: input.actor.id,
      },
    })
    const event = await tx.prospectContactSuppressionEvent.create({
      data: {
        contactId: contact.id,
        eventType: 'RESTORED',
        source: 'HUMAN',
        reasonCode: input.reasonCode.trim(),
        reason: input.reason.trim(),
        actorType: 'HUMAN',
        actorId: input.actor.id,
        evidence: {
          priorSuppressedAt: contact.suppressedAt?.toISOString() ?? null,
          priorPermissionState: contact.permissionState,
        },
        occurredAt: now,
      },
    })
    await writeAuditLogStrict(
      {
        actorId: input.actor.id,
        actorRole: input.actor.role,
        action: 'prospect.contactability.restore',
        targetType: 'ProspectContact',
        targetId: contact.id,
        beforeState: {
          doNotContact: contact.doNotContact,
          permissionState: contact.permissionState,
          suppressedAt: contact.suppressedAt?.toISOString() ?? null,
        },
        afterState: {
          doNotContact: saved.doNotContact,
          permissionState: saved.permissionState,
          suppressedAt: null,
          eventId: event.id,
        },
      },
      tx,
    )
    return { contact: saved, event }
  })
}
