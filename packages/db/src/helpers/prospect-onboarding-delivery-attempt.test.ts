import { describe, expect, it } from 'vitest'

import { preparePositiveInterestDeliveryDraft } from './prospect-onboarding-delivery-attempt'

const input = {
  organizationId: 'org-1',
  organizationName: 'North Museum Group',
  prospectVenueId: 'venue-1',
  venueName: 'North Museum',
  contactId: 'contact-1',
  contactOrganizationId: 'org-1',
  contactVenueId: null,
  contactNormalizedEmail: 'guide@example.test',
  messageId: 'message-1',
  messageOrganizationId: 'org-1',
  messageVenueId: 'venue-1',
  messageContactId: 'contact-1',
  messageFromAddress: 'Guide@Example.Test',
  sourceReviewId: 'review-1',
  sourceReviewDisposition: 'POSITIVE_INTEREST',
  sourceReference: 'gmail://message/message-1',
  reviewerId: 'founder-1',
}

describe('positive-interest onboarding delivery draft', () => {
  it('binds an organization-wide contact to the exact message venue without sending', () => {
    expect(preparePositiveInterestDeliveryDraft(input)).toMatchObject({
      status: 'DRAFT',
      organizationId: 'org-1',
      prospectVenueId: 'venue-1',
      contactId: 'contact-1',
      recipientEmailSnapshot: 'guide@example.test',
      sourceMessageId: 'message-1',
      sourceReviewId: 'review-1',
      templateVersion: 'positive-interest-onboarding-v1',
      textBody: expect.stringContaining('Reply with any visitor guides'),
    })
  })

  it('makes venue scope part of the deterministic attempt identity', () => {
    const first = preparePositiveInterestDeliveryDraft(input)
    const second = preparePositiveInterestDeliveryDraft({
      ...input,
      prospectVenueId: 'venue-2',
      venueName: 'South Museum',
      messageVenueId: 'venue-2',
    })
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey)
  })

  it.each([
    { messageVenueId: null },
    { messageContactId: null },
    { contactOrganizationId: 'org-2' },
    { contactVenueId: 'venue-2' },
    { messageFromAddress: 'different@example.test' },
    { sourceReviewDisposition: 'OTHER' },
  ])('rejects ambiguous or mismatched retained identity %#', (patch) => {
    expect(() => preparePositiveInterestDeliveryDraft({ ...input, ...patch })).toThrow()
  })
})
