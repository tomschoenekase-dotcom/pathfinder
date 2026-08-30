import { describe, expect, it, vi } from 'vitest'

import { reviewProspectInboundReplyAction } from './prospect-inbound-reply-review-actions'

function fixture(direction: 'INBOUND' | 'OUTBOUND' = 'INBOUND') {
  const createdAt = new Date('2026-08-30T16:50:00.000Z')
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    prospectInboundReplyReview: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue({ revision: 1 }),
      create: vi.fn().mockResolvedValue({
        id: '3f116d5c-1d42-4ee6-b983-c3fe86038f65',
        operationId: 'd67122c0-c2f4-4eb7-8f02-6200506b073e',
        messageId: 'message-1',
        organizationId: 'organization-1',
        disposition: 'POSITIVE_INTEREST',
        reason: 'They asked to schedule a product conversation.',
        reviewerId: 'founder-1',
        revision: 2,
        inputHash: 'a'.repeat(64),
        createdAt,
      }),
    },
    prospectEmailMessage: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'message-1',
        organizationId: 'organization-1',
        direction,
        sourceReference: 'gmail://message/message-1',
        inboundReplyDisposition: null,
        inboundReplyReviewId: null,
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    platformOperationalEvent: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const client = { $transaction: vi.fn((work) => work(tx)) }
  const input = {
    operationId: 'd67122c0-c2f4-4eb7-8f02-6200506b073e',
    messageId: 'message-1',
    disposition: 'POSITIVE_INTEREST' as const,
    reason: 'They asked to schedule a product conversation.',
    actor: { type: 'HUMAN' as const, id: 'founder-1', role: 'PLATFORM_ADMIN' as const },
  }
  return { tx, client, input, createdAt }
}

describe('reviewProspectInboundReplyAction', () => {
  it('retains human review evidence and updates current truth plus founder attention', async () => {
    const { tx, client, input, createdAt } = fixture()

    await expect(reviewProspectInboundReplyAction(input, client as never)).resolves.toMatchObject({
      replayed: false,
      review: { disposition: 'POSITIVE_INTEREST', revision: 2 },
    })
    expect(tx.prospectEmailMessage.update).toHaveBeenCalledWith({
      where: { id: 'message-1' },
      data: {
        inboundReplyDisposition: 'POSITIVE_INTEREST',
        inboundReplyReviewId: '3f116d5c-1d42-4ee6-b983-c3fe86038f65',
        inboundReplyReviewedAt: createdAt,
        inboundReplyReviewerId: 'founder-1',
      },
    })
    expect(tx.platformOperationalEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ linkedObjectId: 'message-1' }),
      data: expect.objectContaining({ title: 'Positive prospect reply needs review' }),
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'prospect-email.inbound-reply-reviewed',
        afterState: expect.objectContaining({
          inferredFromMessageText: false,
          emailSent: false,
          pipelineStageChanged: false,
        }),
      }),
    })
  })

  it('replays an exact operation without another write', async () => {
    const { tx, client, input } = fixture()
    const first = await reviewProspectInboundReplyAction(input, client as never)
    const retainedInputHash = tx.prospectInboundReplyReview.create.mock.calls[0]![0].data.inputHash
    tx.prospectInboundReplyReview.findUnique.mockResolvedValue({
      ...first.review,
      inputHash: retainedInputHash,
    })
    tx.prospectInboundReplyReview.create.mockClear()
    tx.prospectEmailMessage.update.mockClear()

    await expect(reviewProspectInboundReplyAction(input, client as never)).resolves.toMatchObject({
      replayed: true,
    })
    expect(tx.prospectInboundReplyReview.create).not.toHaveBeenCalled()
    expect(tx.prospectEmailMessage.update).not.toHaveBeenCalled()
  })

  it('rejects outbound messages without recording a classification', async () => {
    const { tx, client, input } = fixture('OUTBOUND')

    await expect(reviewProspectInboundReplyAction(input, client as never)).rejects.toThrow(
      'Only inbound prospect replies can be reviewed',
    )
    expect(tx.prospectInboundReplyReview.create).not.toHaveBeenCalled()
  })
})
