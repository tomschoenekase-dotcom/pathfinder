import { createHash } from 'node:crypto'
import type { ProspectInboundReplyDisposition } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import { ProspectActionError, type ProspectActor } from './prospect-actions'

type Client = typeof db

const dispositions = new Set<ProspectInboundReplyDisposition>([
  'POSITIVE_INTEREST',
  'QUESTION_OR_OBJECTION',
  'NOT_INTERESTED',
  'SUPPRESSION_REQUEST',
  'OTHER',
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

function inputHash(input: {
  messageId: string
  disposition: ProspectInboundReplyDisposition
  reason: string
  reviewerId: string
}) {
  return createHash('sha256')
    .update('torchiko-prospect-inbound-reply-review-v1\0')
    .update(JSON.stringify(input))
    .digest('hex')
}

function attentionCopy(disposition: ProspectInboundReplyDisposition) {
  switch (disposition) {
    case 'POSITIVE_INTEREST':
      return {
        title: 'Positive prospect reply needs review',
        summary: 'A human classified the matched prospect reply as positive interest.',
        recommendedAction: 'Review the canonical Gmail thread and decide the next human response.',
      }
    case 'QUESTION_OR_OBJECTION':
      return {
        title: 'Prospect question or objection needs review',
        summary: 'A human classified the matched reply as a question or objection.',
        recommendedAction: 'Review the canonical Gmail thread before preparing a response.',
      }
    case 'NOT_INTERESTED':
      return {
        title: 'Prospect reply marked not interested',
        summary: 'A human classified the matched reply as not interested.',
        recommendedAction: 'Review the relationship and record the appropriate CRM stage.',
      }
    case 'SUPPRESSION_REQUEST':
      return {
        title: 'Prospect suppression request needs confirmation',
        summary: 'A human classified the matched reply as a suppression request.',
        recommendedAction: 'Confirm suppression is active before any further correspondence.',
      }
    case 'OTHER':
      return {
        title: 'Classified prospect reply needs review',
        summary: 'A human reviewed the matched reply but no narrower disposition applies.',
        recommendedAction: 'Review the canonical Gmail thread and decide the next CRM action.',
      }
  }
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002',
  )
}

const reviewSelect = {
  id: true,
  operationId: true,
  messageId: true,
  organizationId: true,
  disposition: true,
  reason: true,
  reviewerId: true,
  revision: true,
  inputHash: true,
  createdAt: true,
} as const

export async function reviewProspectInboundReplyAction(
  input: {
    operationId: string
    messageId: string
    disposition: ProspectInboundReplyDisposition
    reason: string
    actor: ProspectActor
  },
  client: Client = db,
) {
  requireActor(input.actor)
  const messageId = bounded(input.messageId, 'Email message ID', 191)
  const reason = bounded(input.reason, 'Review reason', 2000)
  if (!dispositions.has(input.disposition)) {
    throw new ProspectActionError('INVALID_INPUT', 'Inbound reply disposition is invalid')
  }
  const hash = inputHash({
    messageId,
    disposition: input.disposition,
    reason,
    reviewerId: input.actor.id,
  })

  try {
    return await client.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`torchiko:prospect-inbound-reply-review:${messageId}`}, 0))`

      const replay = await tx.prospectInboundReplyReview.findUnique({
        where: { operationId: input.operationId },
        select: reviewSelect,
      })
      if (replay) {
        if (replay.inputHash !== hash) {
          throw new ProspectActionError(
            'CONFLICT',
            'Inbound reply review operation ID was already used for different input',
          )
        }
        return { review: replay, replayed: true as const }
      }

      const message = await tx.prospectEmailMessage.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          organizationId: true,
          direction: true,
          sourceReference: true,
          inboundReplyDisposition: true,
          inboundReplyReviewId: true,
        },
      })
      if (!message) throw new ProspectActionError('NOT_FOUND', 'Email message was not found')
      if (message.direction !== 'INBOUND') {
        throw new ProspectActionError(
          'INVALID_INPUT',
          'Only inbound prospect replies can be reviewed',
        )
      }

      const latest = await tx.prospectInboundReplyReview.findFirst({
        where: { messageId },
        orderBy: { revision: 'desc' },
        select: { revision: true },
      })
      const review = await tx.prospectInboundReplyReview.create({
        data: {
          operationId: input.operationId,
          messageId,
          organizationId: message.organizationId,
          disposition: input.disposition,
          reason,
          reviewerId: input.actor.id,
          revision: (latest?.revision ?? 0) + 1,
          inputHash: hash,
        },
        select: reviewSelect,
      })
      await tx.prospectEmailMessage.update({
        where: { id: messageId },
        data: {
          inboundReplyDisposition: review.disposition,
          inboundReplyReviewId: review.id,
          inboundReplyReviewedAt: review.createdAt,
          inboundReplyReviewerId: review.reviewerId,
        },
      })

      const copy = attentionCopy(review.disposition)
      await tx.platformOperationalEvent.updateMany({
        where: {
          eventType: 'crm.reply.received',
          linkedObjectType: 'ProspectEmailMessage',
          linkedObjectId: messageId,
          state: { in: ['OPEN', 'ACKNOWLEDGED'] },
        },
        data: copy,
      })
      await writeAuditLogStrict(
        {
          actorId: input.actor.id,
          actorRole: input.actor.role,
          action: 'prospect-email.inbound-reply-reviewed',
          targetType: 'ProspectEmailMessage',
          targetId: messageId,
          sourceReferences: [
            { type: 'ProspectEmailMessage', id: messageId, ref: message.sourceReference },
            { type: 'ProspectInboundReplyReview', id: review.id },
          ],
          structuredReason: { disposition: review.disposition, reason },
          beforeState: {
            disposition: message.inboundReplyDisposition,
            reviewId: message.inboundReplyReviewId,
          },
          afterState: {
            disposition: review.disposition,
            reviewId: review.id,
            revision: review.revision,
            inferredFromMessageText: false,
            emailSent: false,
            pipelineStageChanged: false,
          },
        },
        tx,
      )
      return { review, replayed: false as const }
    })
  } catch (error) {
    if (error instanceof ProspectActionError) throw error
    if (isUniqueConstraintError(error)) {
      throw new ProspectActionError(
        'CONFLICT',
        'Inbound reply review conflicts with newer evidence',
      )
    }
    throw error
  }
}
