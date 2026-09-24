import { createHash } from 'node:crypto'
import type { ProspectInboundReplyDisposition } from '@prisma/client'

import { db } from '../client'
import { writeAuditLogStrict } from './audit'
import {
  preparePositiveInterestDeliveryDraft,
  prospectOnboardingDeliveryAttemptSelect,
} from './prospect-onboarding-delivery-attempt'
import { ProspectActionError, type ProspectActor } from './prospect-actions'
import { recordProspectSuppressionInTransaction } from './prospect-contactability-actions'

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
        title: 'Prospect suppression request applied',
        summary: 'A human classified the matched reply as a suppression request.',
        recommendedAction:
          'Contact suppression is active. Do not send; restoration requires the separate authorized owner.',
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
        const deliveryAttempt =
          replay.disposition === 'POSITIVE_INTEREST'
            ? await tx.prospectOnboardingDeliveryAttempt.findFirst({
                where: { sourceMessageId: replay.messageId },
                select: prospectOnboardingDeliveryAttemptSelect,
              })
            : null
        if (replay.disposition === 'POSITIVE_INTEREST' && !deliveryAttempt) {
          throw new ProspectActionError(
            'CONFLICT',
            'Positive-interest review is missing its onboarding delivery draft',
          )
        }
        return { review: replay, deliveryAttempt, replayed: true as const }
      }

      const message = await tx.prospectEmailMessage.findUnique({
        where: { id: messageId },
        select: {
          id: true,
          organizationId: true,
          venueId: true,
          contactId: true,
          fromAddress: true,
          direction: true,
          sourceReference: true,
          inboundReplyDisposition: true,
          inboundReplyReviewId: true,
          organization: { select: { canonicalName: true } },
          venue: { select: { id: true, name: true } },
          contact: {
            select: {
              id: true,
              organizationId: true,
              venueId: true,
              normalizedEmail: true,
            },
          },
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

      let deliveryAttempt = null
      if (review.disposition === 'SUPPRESSION_REQUEST') {
        if (
          !message.contactId ||
          message.contact?.organizationId !== message.organizationId ||
          message.contact.normalizedEmail !== message.fromAddress.toLowerCase()
        )
          throw new ProspectActionError(
            'CONFLICT',
            'Suppression requires an exact matched sender/contact; resolve identity without marking suppression applied',
          )
        await recordProspectSuppressionInTransaction(
          {
            contactId: message.contactId,
            eventType: 'UNSUBSCRIBED',
            source: 'INBOUND_MESSAGE',
            reasonCode: 'HUMAN_REVIEWED_SUPPRESSION_REQUEST',
            reason,
            evidence: { messageId, reviewId: review.id, sourceReference: message.sourceReference },
            actor: { type: 'HUMAN', role: 'PLATFORM_ADMIN', id: input.actor.id },
          },
          tx,
        )
      }
      if (review.disposition === 'POSITIVE_INTEREST') {
        if (!message.venue || !message.venueId || !message.contact || !message.contactId) {
          throw new ProspectActionError(
            'INVALID_INPUT',
            'Positive-interest onboarding requires an explicitly matched venue and contact',
          )
        }
        const draft = preparePositiveInterestDeliveryDraft({
          organizationId: message.organizationId,
          organizationName: message.organization.canonicalName,
          prospectVenueId: message.venueId,
          venueName: message.venue.name,
          contactId: message.contactId,
          contactOrganizationId: message.contact.organizationId,
          contactVenueId: message.contact.venueId,
          contactNormalizedEmail: message.contact.normalizedEmail,
          messageId,
          messageOrganizationId: message.organizationId,
          messageVenueId: message.venueId,
          messageContactId: message.contactId,
          messageFromAddress: message.fromAddress,
          sourceReviewId: review.id,
          sourceReviewDisposition: review.disposition,
          sourceReference: message.sourceReference,
          reviewerId: review.reviewerId,
        })
        const existingAttempt = await tx.prospectOnboardingDeliveryAttempt.findUnique({
          where: {
            sourceMessageId_prospectVenueId: {
              sourceMessageId: messageId,
              prospectVenueId: message.venueId,
            },
          },
          select: prospectOnboardingDeliveryAttemptSelect,
        })
        if (existingAttempt) {
          if (
            existingAttempt.organizationId !== draft.organizationId ||
            existingAttempt.contactId !== draft.contactId ||
            existingAttempt.recipientIdentityHash !== draft.recipientIdentityHash ||
            existingAttempt.status !== 'DRAFT'
          ) {
            throw new ProspectActionError(
              'CONFLICT',
              'Existing onboarding delivery draft does not match current retained identity',
            )
          }
          deliveryAttempt = existingAttempt
        } else {
          deliveryAttempt = await tx.prospectOnboardingDeliveryAttempt.create({
            data: draft,
            select: prospectOnboardingDeliveryAttemptSelect,
          })
        }
      }

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
            ...(deliveryAttempt
              ? [{ type: 'ProspectOnboardingDeliveryAttempt', id: deliveryAttempt.id }]
              : []),
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
            onboardingDeliveryAttemptId: deliveryAttempt?.id ?? null,
            onboardingInvitationStatus: deliveryAttempt?.status ?? null,
            providerCalled: false,
            invitationSent: false,
          },
        },
        tx,
      )
      return { review, deliveryAttempt, replayed: false as const }
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
