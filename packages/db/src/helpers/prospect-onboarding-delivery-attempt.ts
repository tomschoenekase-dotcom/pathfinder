import { createHash } from 'node:crypto'

import { ProspectActionError } from './prospect-actions'

const TEMPLATE_VERSION = 'positive-interest-onboarding-v1'

export const prospectOnboardingDeliveryAttemptSelect = {
  id: true,
  idempotencyKey: true,
  status: true,
  organizationId: true,
  prospectVenueId: true,
  contactId: true,
  sourceMessageId: true,
  sourceReviewId: true,
  sourceReference: true,
  recipientEmailSnapshot: true,
  recipientIdentityHash: true,
  templateVersion: true,
  subject: true,
  textBody: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const

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

function normalizeEmail(value: string) {
  const normalized = bounded(value, 'Recipient email', 320).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) {
    throw new ProspectActionError('INVALID_INPUT', 'Recipient email is invalid')
  }
  return normalized
}

export function positiveInterestDeliveryIdempotencyKey(messageId: string, prospectVenueId: string) {
  return bounded(
    `positive-interest:${bounded(messageId, 'Email message ID', 191)}:${bounded(
      prospectVenueId,
      'Prospect venue ID',
      191,
    )}`,
    'Onboarding delivery idempotency key',
    191,
  )
}

export function preparePositiveInterestDeliveryDraft(input: {
  organizationId: string
  organizationName: string
  prospectVenueId: string
  venueName: string
  contactId: string
  contactOrganizationId: string
  contactVenueId: string | null
  contactNormalizedEmail: string | null
  messageId: string
  messageOrganizationId: string
  messageVenueId: string | null
  messageContactId: string | null
  messageFromAddress: string
  sourceReviewId: string
  sourceReviewDisposition: string
  sourceReference: string | null
  reviewerId: string
}) {
  const organizationId = bounded(input.organizationId, 'Organization ID', 191)
  const prospectVenueId = bounded(input.prospectVenueId, 'Prospect venue ID', 191)
  const contactId = bounded(input.contactId, 'Contact ID', 191)
  const messageId = bounded(input.messageId, 'Email message ID', 191)
  const reviewerId = bounded(input.reviewerId, 'Reviewer ID', 191)

  if (input.sourceReviewDisposition !== 'POSITIVE_INTEREST') {
    throw new ProspectActionError(
      'INVALID_INPUT',
      'An onboarding delivery draft requires a positive-interest human review',
    )
  }
  if (
    input.messageOrganizationId !== organizationId ||
    input.messageVenueId !== prospectVenueId ||
    input.messageContactId !== contactId ||
    input.contactOrganizationId !== organizationId ||
    (input.contactVenueId !== null && input.contactVenueId !== prospectVenueId)
  ) {
    throw new ProspectActionError(
      'CONFLICT',
      'Inbound reply, organization, venue, and contact scope do not match',
    )
  }

  const recipientEmail = normalizeEmail(input.contactNormalizedEmail ?? '')
  if (normalizeEmail(input.messageFromAddress) !== recipientEmail) {
    throw new ProspectActionError(
      'CONFLICT',
      'Inbound sender does not match the retained prospect contact',
    )
  }

  const organizationName = bounded(input.organizationName, 'Organization name', 300)
  const venueName = bounded(input.venueName, 'Venue name', 300)
  const subject = `Your Torchiko onboarding for ${venueName}`.slice(0, 998)
  const textBody = [
    `Thanks for your interest in Torchiko for ${venueName}.`,
    '',
    `We can begin with the information ${organizationName} already has and gather any missing details in a short, reviewable onboarding flow.`,
    '',
    'Reply with any visitor guides, maps, opening hours, or frequently asked questions you would like us to start with. We can help organize the rest.',
  ].join('\n')

  return {
    idempotencyKey: positiveInterestDeliveryIdempotencyKey(messageId, prospectVenueId),
    status: 'DRAFT' as const,
    organizationId,
    prospectVenueId,
    contactId,
    sourceMessageId: messageId,
    sourceReviewId: bounded(input.sourceReviewId, 'Source review ID', 191),
    sourceReference: input.sourceReference?.trim().slice(0, 1000) || null,
    recipientEmailSnapshot: recipientEmail,
    recipientIdentityHash: createHash('sha256')
      .update('torchiko-onboarding-recipient-v1\0')
      .update(contactId)
      .update('\0')
      .update(recipientEmail)
      .digest('hex'),
    templateVersion: TEMPLATE_VERSION,
    subject,
    textBody,
    createdBy: reviewerId,
  }
}
