import type {
  SupportMessageVisibility,
  SupportRequestCategory,
} from '@pathfinder/contracts/support-workflow'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'

export type SupportActionActor =
  | {
      actorType: 'HUMAN'
      participantKind: 'CLIENT' | 'OPERATOR'
      actorId: string
      auditRole: string
    }
  | { actorType: 'AGENT'; participantKind: 'AGENT'; actorId: string; auditRole: string }
  | { actorType: 'SYSTEM'; participantKind: 'SYSTEM'; actorId: string; auditRole: string }

export type SupportAttachmentDraft = {
  filename: string
  mediaType: string
  byteSize: number
  sourceId?: string | undefined
}
type SupportActionClient = Pick<typeof db, '$transaction'>

export class SupportActionError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN',
    message: string,
  ) {
    super(message)
    this.name = 'SupportActionError'
  }
}

const requestSelect = {
  id: true,
  venueId: true,
  category: true,
  status: true,
  subject: true,
  missingInformation: true,
  version: true,
  statusChangedAt: true,
  createdAt: true,
  updatedAt: true,
} as const
const messageSelect = {
  id: true,
  tenantId: true,
  venueId: true,
  supportRequestId: true,
  authorKind: true,
  authorId: true,
  visibility: true,
  body: true,
  createdAt: true,
  attachments: {
    select: {
      id: true,
      filename: true,
      mediaType: true,
      byteSize: true,
      sourceId: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const

function attachmentCreates(
  attachments: SupportAttachmentDraft[],
  scope: { tenantId: string; venueId: string; requestId: string },
) {
  return attachments.map((attachment) => ({
    tenantId: scope.tenantId,
    venueId: scope.venueId,
    supportRequestId: scope.requestId,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    byteSize: BigInt(attachment.byteSize),
    ...(attachment.sourceId !== undefined ? { sourceId: attachment.sourceId } : {}),
  }))
}

function assertVisibility(actor: SupportActionActor, visibility: SupportMessageVisibility) {
  if (actor.participantKind === 'CLIENT' && visibility === 'INTERNAL_ONLY')
    throw new SupportActionError('FORBIDDEN', 'Client-authored messages cannot be internal-only')
}

function appendEvidence(actor: SupportActionActor, visibility: SupportMessageVisibility) {
  if (actor.participantKind === 'CLIENT')
    return { eventType: 'CLIENT_MESSAGE_ADDED', action: 'support-request.client-message-added' }
  if (actor.participantKind === 'OPERATOR')
    return visibility === 'INTERNAL_ONLY'
      ? { eventType: 'INTERNAL_NOTE_ADDED', action: 'support-request.internal-note-added' }
      : { eventType: 'OPERATOR_MESSAGE_ADDED', action: 'support-request.operator-message-added' }
  if (actor.participantKind === 'AGENT')
    return visibility === 'INTERNAL_ONLY'
      ? {
          eventType: 'AGENT_INTERNAL_NOTE_ADDED',
          action: 'support-request.agent-internal-note-added',
        }
      : { eventType: 'AGENT_MESSAGE_ADDED', action: 'support-request.agent-message-added' }
  return visibility === 'INTERNAL_ONLY'
    ? {
        eventType: 'SYSTEM_INTERNAL_NOTE_ADDED',
        action: 'support-request.system-internal-note-added',
      }
    : { eventType: 'SYSTEM_MESSAGE_ADDED', action: 'support-request.system-message-added' }
}

export async function createSupportRequestAction(
  input: {
    tenantId: string
    venueId: string
    category: SupportRequestCategory
    subject: string
    body: string
    attachments: SupportAttachmentDraft[]
    actor: SupportActionActor
  },
  client: SupportActionClient = db,
) {
  assertVisibility(input.actor, 'CLIENT_VISIBLE')
  return client.$transaction(async (tx) => {
    const venue = await tx.venue.findFirst({
      where: { id: input.venueId, tenantId: input.tenantId },
      select: { id: true },
    })
    if (!venue) throw new SupportActionError('NOT_FOUND', 'Venue not found')
    const request = await tx.supportRequest.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        category: input.category,
        subject: input.subject,
        artifacts: {},
        createdByKind: input.actor.participantKind,
        createdById: input.actor.actorId,
        updatedByKind: input.actor.participantKind,
        updatedById: input.actor.actorId,
      },
      select: requestSelect,
    })
    const message = await tx.supportMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        authorKind: input.actor.participantKind,
        authorId: input.actor.actorId,
        visibility: 'CLIENT_VISIBLE',
        body: input.body,
        attachments: {
          create: attachmentCreates(input.attachments, {
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: request.id,
          }),
        },
      },
      select: messageSelect,
    })
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: request.version,
        eventType: 'REQUEST_CREATED',
        actorKind: input.actor.participantKind,
        actorId: input.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: 'support-request.created',
        targetType: 'SupportRequest',
        targetId: request.id,
        afterState: {
          venueId: request.venueId,
          category: request.category,
          status: request.status,
          version: request.version,
        },
      },
      tx,
    )
    return { request, message }
  })
}

export async function appendSupportMessageAction(
  input: {
    tenantId: string
    venueId: string
    requestId: string
    expectedVersion: number
    visibility: SupportMessageVisibility
    body: string
    attachments: SupportAttachmentDraft[]
    actor: SupportActionActor
  },
  client: SupportActionClient = db,
) {
  assertVisibility(input.actor, input.visibility)
  return client.$transaction(async (tx) => {
    const request = await tx.supportRequest.findFirst({
      where: { id: input.requestId, tenantId: input.tenantId, venueId: input.venueId },
      select: { id: true, status: true, version: true },
    })
    if (!request) throw new SupportActionError('NOT_FOUND', 'Support request not found')
    if (
      input.actor.participantKind !== 'OPERATOR' &&
      (request.status === 'COMPLETED' || request.status === 'CANCELLED')
    )
      throw new SupportActionError('CONFLICT', 'This support request is closed')
    if (request.version !== input.expectedVersion)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const nextVersion = request.version + 1
    const changed = await tx.supportRequest.updateMany({
      where: {
        id: request.id,
        tenantId: input.tenantId,
        venueId: input.venueId,
        version: input.expectedVersion,
      },
      data: {
        version: nextVersion,
        updatedByKind: input.actor.participantKind,
        updatedById: input.actor.actorId,
      },
    })
    if (changed.count !== 1)
      throw new SupportActionError('CONFLICT', 'Support request changed; refresh it')
    const message = await tx.supportMessage.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        authorKind: input.actor.participantKind,
        authorId: input.actor.actorId,
        visibility: input.visibility,
        body: input.body,
        attachments: {
          create: attachmentCreates(input.attachments, {
            tenantId: input.tenantId,
            venueId: input.venueId,
            requestId: request.id,
          }),
        },
      },
      select: messageSelect,
    })
    const evidence = appendEvidence(input.actor, input.visibility)
    await tx.supportRequestAuditEvent.create({
      data: {
        tenantId: input.tenantId,
        venueId: input.venueId,
        supportRequestId: request.id,
        requestVersion: nextVersion,
        eventType: evidence.eventType,
        actorKind: input.actor.participantKind,
        actorId: input.actor.actorId,
        fromStatus: null,
        toStatus: null,
      },
      select: { id: true },
    })
    await writeAuditLogStrict(
      {
        tenantId: input.tenantId,
        actorId: input.actor.actorId,
        actorRole: input.actor.auditRole,
        action: evidence.action,
        targetType: 'SupportRequest',
        targetId: request.id,
        beforeState: { version: request.version },
        afterState: {
          version: nextVersion,
          ...(input.actor.participantKind === 'OPERATOR' ? { visibility: input.visibility } : {}),
        },
      },
      tx,
    )
    return { message, requestVersion: nextVersion }
  })
}
