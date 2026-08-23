import { describe, expect, it, vi } from 'vitest'

import { recordProspectInboundReplyAction } from './prospect-inbound-reply-actions'

function fixture(stage: string | null, campaignMemberId: string | null = 'member-1') {
  const tx = {
    prospectOpportunity: {
      findUnique: vi.fn().mockResolvedValue(stage ? { id: 'opportunity-1', stage } : null),
      update: vi.fn().mockResolvedValue({}),
    },
    prospectActivity: { create: vi.fn().mockResolvedValue({ id: 'activity-1' }) },
    prospectCampaignMember: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    prospectStageHistory: { create: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  }
  const client = { $transaction: vi.fn((work) => work(tx)) }
  const input = {
    prospectOrganizationId: 'organization-1',
    contactId: 'contact-1',
    campaignMemberId,
    canonicalMessageId: 'message-1',
    canonicalThreadId: 'thread-1',
    matchingEvidence: ['PROVIDER_THREAD', 'RFC_REFERENCE'],
    occurredAt: new Date('2026-08-22T16:00:00.000Z'),
  }
  return { tx, client, input }
}

describe('recordProspectInboundReplyAction', () => {
  it.each(['CONTACTED', 'FOLLOW_UP_DUE'])(
    'advances an outreach-stage opportunity from %s to REPLIED with history and audit evidence',
    async (stage) => {
      const { tx, client, input } = fixture(stage)

      const result = await recordProspectInboundReplyAction(input, client as never)

      expect(result).toMatchObject({
        opportunityId: 'opportunity-1',
        fromStage: stage,
        toStage: 'REPLIED',
        stageChanged: true,
      })
      expect(tx.prospectOpportunity.update).toHaveBeenCalledWith({
        where: { id: 'opportunity-1' },
        data: {
          stage: 'REPLIED',
          lastActivityAt: input.occurredAt,
          updatedBy: 'gmail-sync',
        },
      })
      expect(tx.prospectStageHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ fromStage: stage, toStage: 'REPLIED' }),
      })
      expect(tx.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          actorType: 'SYSTEM',
          action: 'system.prospect.inbound_reply_recorded',
          beforeState: { stage },
          afterState: expect.objectContaining({ stage: 'REPLIED', stageChanged: true }),
        }),
      })
    },
  )

  it.each(['REPLIED', 'CONVERSATION', 'QUALIFIED', 'WON', 'LOST', 'PARKED', 'DO_NOT_CONTACT'])(
    'does not regress or revive an opportunity already in %s',
    async (stage) => {
      const { tx, client, input } = fixture(stage)

      const result = await recordProspectInboundReplyAction(input, client as never)

      expect(result).toMatchObject({ fromStage: stage, toStage: stage, stageChanged: false })
      expect(tx.prospectOpportunity.update).toHaveBeenCalledWith({
        where: { id: 'opportunity-1' },
        data: { lastActivityAt: input.occurredAt, updatedBy: 'gmail-sync' },
      })
      expect(tx.prospectStageHistory.create).not.toHaveBeenCalled()
    },
  )

  it('records unmatched-campaign activity and audit evidence without inventing an opportunity', async () => {
    const { tx, client, input } = fixture(null, null)

    await expect(recordProspectInboundReplyAction(input, client as never)).resolves.toMatchObject({
      opportunityId: null,
      stageChanged: false,
    })
    expect(tx.prospectCampaignMember.updateMany).not.toHaveBeenCalled()
    expect(tx.prospectOpportunity.update).not.toHaveBeenCalled()
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        targetType: 'ProspectOrganization',
        targetId: 'organization-1',
      }),
    })
  })
})
