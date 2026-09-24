import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { firstSendActionShapes } from './prospect-first-send-contract'
const schema = z.discriminatedUnion('action', firstSendActionShapes)
const base = { venueId: 'v', expectedSnapshotHash: 'a'.repeat(64) }
const handoff = {
  action: 'handoffOperational',
  input: {
    ...base,
    draftId: 'd',
    contentHash: 'b'.repeat(64),
    meaningReviewId: 'm',
    providerAccountId: 'a',
    campaignName: 'Explicit candidate selection',
  },
}
describe('one exact native-origin operational handoff', () => {
  it('accepts only identity-bearing explicit selection, not automatic send authority', () =>
    expect(schema.parse(handoff)).toEqual(handoff))
  it.each([
    'actor',
    'humanApproval',
    'sourceFacts',
    'toEmail',
    'generatedBy',
    'permissionState',
    'deliveryEnabled',
  ])('rejects authority/body replacement field %s', (key) =>
    expect(schema.safeParse({ ...handoff, input: { ...handoff.input, [key]: true } }).success).toBe(
      false,
    ),
  )
  it('does not expose a live sender or provider switch operation', () => {
    for (const action of [
      'send',
      'dispatch',
      'releaseLiveBatch',
      'connectMailbox',
      'enableDelivery',
      'importCampaign',
    ])
      expect(schema.safeParse({ action, input: base }).success).toBe(false)
  })
  it('requires the exact frozen count of one', () => {
    for (const count of [0, 2, 100])
      expect(
        schema.safeParse({
          action: 'approveOperationalBatch',
          input: {
            ...base,
            batchId: 'b',
            expectedRecipientCount: count,
            expectedBatchHash: 'a'.repeat(64),
          },
        }).success,
      ).toBe(false)
  })
  it('does not accept an old review ID in place of exact operational content', () => {
    expect(
      schema.safeParse({
        action: 'reviewOperational',
        input: { ...base, draftId: 'd', meaningReviewId: 'm' },
      }).success,
    ).toBe(false)
  })
})
