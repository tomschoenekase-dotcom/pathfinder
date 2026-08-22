import { describe, expect, it, vi } from 'vitest'

import {
  evaluateProspectFollowupReadinessAction,
  scheduleProspectFollowupAction,
} from './prospect-followup-actions'

describe('prospect follow-up policy', () => {
  it('requires a human administrator and a sequence of no more than two', async () => {
    const client = { $transaction: vi.fn() }
    await expect(
      scheduleProspectFollowupAction(
        {
          triggerSendItemId: 'send-1',
          sequenceNumber: 1,
          dueAt: new Date('2026-08-24T16:00:00.000Z'),
          reason: 'Approved first follow-up',
          actor: { type: 'HUMAN', id: '', role: 'PLATFORM_ADMIN' },
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' })
    await expect(
      scheduleProspectFollowupAction(
        {
          triggerSendItemId: 'send-1',
          sequenceNumber: 3 as never,
          dueAt: new Date('2026-08-24T16:00:00.000Z'),
          reason: 'Third follow-up',
          actor: { type: 'HUMAN', id: 'tom', role: 'PLATFORM_ADMIN' },
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(client.$transaction).not.toHaveBeenCalled()
  })

  it('holds a due follow-up when an inbound reply arrived after the originating send', async () => {
    const update = vi.fn().mockResolvedValue({})
    const tx = {
      prospectFollowup: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'followup-1',
          organizationId: 'organization-1',
          status: 'PENDING',
          dueAt: new Date('2026-08-22T15:00:00.000Z'),
          policyApprovedAt: new Date('2026-08-20T15:00:00.000Z'),
          policyApprovedBy: 'tom',
          opportunity: { stage: 'CONTACTED' },
          campaignMember: {
            status: 'SENT',
            contact: {
              archivedAt: null,
              doNotContact: false,
              emailReadiness: 'VALID',
              permissionState: 'UNKNOWN',
              suppressedAt: null,
              unsubscribedAt: null,
            },
          },
          triggerSendItem: { sentAt: new Date('2026-08-20T16:00:00.000Z') },
        }),
        update,
      },
      prospectEmailMessage: { count: vi.fn().mockResolvedValue(1) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      evaluateProspectFollowupReadinessAction(
        { followupId: 'followup-1', now: new Date('2026-08-22T16:00:00.000Z') },
        client as never,
      ),
    ).resolves.toBe('HELD_REPLY')
    expect(tx.prospectEmailMessage.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ direction: 'INBOUND' }),
      }),
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'ON_HOLD_REPLY_RECEIVED' }),
      }),
    )
  })

  it('only marks an eligible due item ready for drafting, never queued or sent', async () => {
    const update = vi.fn().mockResolvedValue({})
    const tx = {
      prospectFollowup: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'followup-1',
          organizationId: 'organization-1',
          status: 'PENDING',
          dueAt: new Date('2026-08-22T15:00:00.000Z'),
          policyApprovedAt: new Date('2026-08-20T15:00:00.000Z'),
          policyApprovedBy: 'tom',
          opportunity: { stage: 'FOLLOW_UP_DUE' },
          campaignMember: {
            status: 'SENT',
            contact: {
              archivedAt: null,
              doNotContact: false,
              emailReadiness: 'VALID',
              permissionState: 'UNKNOWN',
              suppressedAt: null,
              unsubscribedAt: null,
            },
          },
          triggerSendItem: { sentAt: new Date('2026-08-20T16:00:00.000Z') },
        }),
        update,
      },
      prospectEmailMessage: { count: vi.fn().mockResolvedValue(0) },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      evaluateProspectFollowupReadinessAction(
        { followupId: 'followup-1', now: new Date('2026-08-22T16:00:00.000Z') },
        client as never,
      ),
    ).resolves.toBe('READY_FOR_DRAFT')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'READY_FOR_DRAFT' }) }),
    )
  })
})
