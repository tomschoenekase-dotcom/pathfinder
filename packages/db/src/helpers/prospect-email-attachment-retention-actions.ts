import type {
  ProspectEmailAttachmentRetentionCategory,
  ProspectEmailAttachmentRetentionStatus,
} from '@prisma/client'
import { Prisma } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { ProspectActionError, type ProspectActor } from './prospect-actions'

type Client = typeof db

type AttachmentMetadata = {
  providerAttachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  downloadPolicy: 'METADATA_ONLY'
}

const categories = new Set<ProspectEmailAttachmentRetentionCategory>([
  'CONTRACT_OR_ORDER_FORM',
  'BROCHURE',
  'FLOOR_PLAN_OR_MAP',
  'VENUE_OPERATIONS',
  'CUSTOMER_KNOWLEDGE',
  'GUIDE_MEDIA',
  'OTHER_BUSINESS_RECORD',
])

function requireActor(actor: ProspectActor) {
  if (actor.type !== 'HUMAN' || actor.role !== 'PLATFORM_ADMIN' || !actor.id.trim()) {
    throw new ProspectActionError('INVALID_INPUT', 'A human platform administrator is required')
  }
}

function bounded(value: string, label: string, max: number) {
  const normalized = value.trim()
  if (!normalized || normalized.length > max) {
    throw new ProspectActionError(
      'INVALID_INPUT',
      `${label} must contain between 1 and ${max} characters`,
    )
  }
  return normalized
}

function attachmentMetadata(value: unknown): AttachmentMetadata[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    if (
      typeof row.providerAttachmentId !== 'string' ||
      !row.providerAttachmentId ||
      typeof row.filename !== 'string' ||
      typeof row.mimeType !== 'string' ||
      typeof row.sizeBytes !== 'number' ||
      !Number.isSafeInteger(row.sizeBytes) ||
      row.sizeBytes < 0 ||
      row.downloadPolicy !== 'METADATA_ONLY'
    ) {
      return []
    }
    return [
      {
        providerAttachmentId: row.providerAttachmentId,
        filename: row.filename,
        mimeType: row.mimeType,
        sizeBytes: row.sizeBytes,
        downloadPolicy: 'METADATA_ONLY' as const,
      },
    ]
  })
}

const requestSelect = {
  id: true,
  operationId: true,
  emailMessageId: true,
  providerAttachmentId: true,
  filename: true,
  mimeType: true,
  sizeBytes: true,
  category: true,
  purpose: true,
  sourceReference: true,
  status: true,
  requestedById: true,
  reviewOperationId: true,
  reviewedById: true,
  reviewReason: true,
  reviewedAt: true,
  createdAt: true,
} as const

export async function prepareProspectEmailAttachmentRetentionAction(
  input: {
    operationId: string
    emailMessageId: string
    providerAttachmentId: string
    category: ProspectEmailAttachmentRetentionCategory
    purpose: string
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  const emailMessageId = bounded(input.emailMessageId, 'Email message ID', 191)
  const providerAttachmentId = bounded(input.providerAttachmentId, 'Provider attachment ID', 512)
  const purpose = bounded(input.purpose, 'Retention purpose', 2000)
  if (!categories.has(input.category)) {
    throw new ProspectActionError('INVALID_INPUT', 'Attachment retention category is invalid')
  }

  try {
    return await client.$transaction(async (tx) => {
      const replay = await tx.prospectEmailAttachmentRetentionRequest.findUnique({
        where: { operationId: input.operationId },
        select: requestSelect,
      })
      if (replay) {
        if (
          replay.emailMessageId !== emailMessageId ||
          replay.providerAttachmentId !== providerAttachmentId ||
          replay.category !== input.category ||
          replay.purpose !== purpose ||
          replay.requestedById !== input.actor.id
        ) {
          throw new ProspectActionError(
            'CONFLICT',
            'Attachment retention operation ID was already used for a different request',
          )
        }
        return { request: replay, replayed: true as const }
      }

      const message = await tx.prospectEmailMessage.findUnique({
        where: { id: emailMessageId },
        select: {
          id: true,
          organizationId: true,
          providerAccountId: true,
          sourceReference: true,
          attachmentMetadata: true,
        },
      })
      if (!message) throw new ProspectActionError('NOT_FOUND', 'Email message was not found')
      if (!message.providerAccountId) {
        throw new ProspectActionError(
          'CONFLICT',
          'Attachment retention requires canonical provider message identity',
        )
      }
      const attachment = attachmentMetadata(message.attachmentMetadata).find(
        (item) => item.providerAttachmentId === providerAttachmentId,
      )
      if (!attachment) {
        throw new ProspectActionError(
          'NOT_FOUND',
          'Exact metadata-only attachment evidence was not found on this email',
        )
      }
      const active = await tx.prospectEmailAttachmentRetentionRequest.findFirst({
        where: {
          emailMessageId,
          providerAttachmentId,
          status: { in: ['AWAITING_REVIEW', 'APPROVED_FOR_IMPORT'] },
        },
        select: { id: true },
      })
      if (active) {
        throw new ProspectActionError(
          'CONFLICT',
          'An active retention review already exists for this attachment',
        )
      }

      const request = await tx.prospectEmailAttachmentRetentionRequest.create({
        data: {
          operationId: input.operationId,
          emailMessageId,
          providerAttachmentId,
          filename: attachment.filename.slice(0, 255),
          mimeType: attachment.mimeType.slice(0, 255),
          sizeBytes: BigInt(attachment.sizeBytes),
          category: input.category,
          purpose,
          sourceReference: message.sourceReference,
          requestedById: input.actor.id,
        },
        select: requestSelect,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect-email.attachment-retention-requested',
          targetType: 'ProspectEmailAttachmentRetentionRequest',
          targetId: request.id,
          sourceReferences: [
            { type: 'ProspectEmailMessage', id: message.id, ref: message.sourceReference },
            { type: 'GmailAttachmentMetadata', id: providerAttachmentId },
          ],
          structuredReason: { category: input.category, purpose },
          afterState: {
            status: request.status,
            providerCallExecuted: false,
            bytesDownloaded: false,
            assetImported: false,
            retentionDurationEstablished: false,
          },
        },
        tx,
      )
      return { request, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof ProspectActionError) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ProspectActionError(
        'CONFLICT',
        'Attachment retention request conflicts with an existing active review or operation',
      )
    }
    throw error
  }
}

export async function reviewProspectEmailAttachmentRetentionAction(
  input: {
    requestId: string
    reviewOperationId: string
    decision: 'APPROVE_FOR_IMPORT' | 'KEEP_SOURCE_ONLY'
    reason: string
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  const requestId = bounded(input.requestId, 'Retention request ID', 191)
  const reviewReason = bounded(input.reason, 'Review reason', 2000)
  const status: ProspectEmailAttachmentRetentionStatus =
    input.decision === 'APPROVE_FOR_IMPORT' ? 'APPROVED_FOR_IMPORT' : 'DECLINED_SOURCE_ONLY'

  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.prospectEmailAttachmentRetentionRequest.findUnique({
        where: { id: requestId },
        select: requestSelect,
      })
      if (!existing) throw new ProspectActionError('NOT_FOUND', 'Retention request was not found')
      if (existing.status !== 'AWAITING_REVIEW') {
        if (
          existing.reviewOperationId === input.reviewOperationId &&
          existing.status === status &&
          existing.reviewedById === input.actor.id &&
          existing.reviewReason === reviewReason
        ) {
          return { request: existing, replayed: true as const }
        }
        throw new ProspectActionError('CONFLICT', 'Retention request has already been reviewed')
      }

      const updated = await tx.prospectEmailAttachmentRetentionRequest.updateMany({
        where: { id: requestId, status: 'AWAITING_REVIEW', reviewOperationId: null },
        data: {
          status,
          reviewOperationId: input.reviewOperationId,
          reviewedById: input.actor.id,
          reviewReason,
          reviewedAt: new Date(),
        },
      })
      if (updated.count !== 1) {
        throw new ProspectActionError('CONFLICT', 'Retention request changed before review')
      }
      const request = await tx.prospectEmailAttachmentRetentionRequest.findUniqueOrThrow({
        where: { id: requestId },
        select: requestSelect,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect-email.attachment-retention-reviewed',
          targetType: 'ProspectEmailAttachmentRetentionRequest',
          targetId: request.id,
          sourceReferences: [
            {
              type: 'ProspectEmailMessage',
              id: request.emailMessageId,
              ref: request.sourceReference,
            },
            { type: 'GmailAttachmentMetadata', id: request.providerAttachmentId },
          ],
          structuredReason: { decision: input.decision, reason: reviewReason },
          beforeState: { status: existing.status },
          afterState: {
            status: request.status,
            providerCallExecuted: false,
            bytesDownloaded: false,
            assetImported: false,
            importRequiresSeparateExecution: request.status === 'APPROVED_FOR_IMPORT',
          },
        },
        tx,
      )
      return { request, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof ProspectActionError) throw error
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ProspectActionError('CONFLICT', 'Review operation identity is already in use')
    }
    throw error
  }
}
