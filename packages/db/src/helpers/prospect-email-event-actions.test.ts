import { describe, expect, it, vi } from 'vitest'

import { applyVerifiedProspectEmailEventAction } from './prospect-email-event-actions'

describe('persisted prospect provider events', () => {
  it('converges on bounce when a stale delivered event arrives later', async () => {
    let status = 'SENT'
    const updateItem = vi.fn(({ data }: { data: { status: string } }) => {
      status = data.status
      return { id: 'item-1', status }
    })
    const tx = {
      prospectSendItem: {
        findUnique: vi.fn(() => ({
          id: 'item-1',
          status,
          providerAccountId: 'mailbox-1',
          providerAccount: { provider: 'GMAIL' },
          message: { id: 'message-1' },
          member: {
            organizationId: 'organization-1',
            contact: { id: 'contact-1' },
          },
        })),
        update: updateItem,
      },
      prospectEmailEvent: { upsert: vi.fn(({ create }) => create) },
      prospectEmailMessage: { update: vi.fn() },
      prospectContact: { update: vi.fn() },
      prospectContactSuppressionEvent: { create: vi.fn() },
      prospectFollowup: { updateMany: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    const common = {
      providerAccountId: 'mailbox-1',
      sendItemId: 'item-1',
      occurredAt: new Date('2026-08-22T16:00:00.000Z'),
    }
    await expect(
      applyVerifiedProspectEmailEventAction(
        { ...common, providerEventId: 'bounce-1', eventType: 'BOUNCED' },
        client as never,
      ),
    ).resolves.toMatchObject({ status: 'BOUNCED' })
    await expect(
      applyVerifiedProspectEmailEventAction(
        { ...common, providerEventId: 'delivered-old', eventType: 'DELIVERED' },
        client as never,
      ),
    ).resolves.toMatchObject({ status: 'BOUNCED' })
    expect(updateItem).toHaveBeenCalledTimes(1)
    expect(tx.prospectContactSuppressionEvent.create).toHaveBeenCalledOnce()
    expect(tx.prospectFollowup.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    )
  })

  it('keeps a policy access-denied bounce separate from address invalidity and account decline', async () => {
    const tx = {
      prospectSendItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'item',
          status: 'SENT',
          providerAccountId: 'mailbox',
          providerAccount: { provider: 'GMAIL' },
          message: { id: 'message' },
          member: { organizationId: 'org', contact: { id: 'contact' } },
        }),
        update: vi.fn(),
      },
      prospectEmailEvent: { upsert: vi.fn(({ create }) => create) },
      prospectEmailMessage: { update: vi.fn() },
      prospectContact: { update: vi.fn() },
      prospectContactSuppressionEvent: { create: vi.fn() },
      prospectFollowup: { updateMany: vi.fn() },
    }
    await applyVerifiedProspectEmailEventAction(
      {
        providerAccountId: 'mailbox',
        providerEventId: 'policy-denied',
        sendItemId: 'item',
        eventType: 'BOUNCED',
        occurredAt: new Date(),
        payload: { smtpStatus: '550 5.7.1 Access denied by policy' },
      },
      { $transaction: vi.fn((work) => work(tx)) } as never,
    )
    expect(tx.prospectContact.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          suppressionReason: 'PROVIDER_POLICY_BLOCK',
          permissionState: 'PROHIBITED',
        }),
      }),
    )
    const data = tx.prospectContact.update.mock.calls[0]![0].data
    expect(data).not.toHaveProperty('emailReadiness')
    expect(data).not.toHaveProperty('lastHardBounceAt')
    expect(tx.prospectContactSuppressionEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'SUPPRESSED' }) }),
    )
  })

  it('rejects an event from a different provider account before persistence', async () => {
    const tx = {
      prospectSendItem: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'item-1',
          providerAccountId: 'mailbox-1',
          providerAccount: { provider: 'GMAIL' },
          message: null,
          member: { contact: null },
        }),
      },
      prospectEmailEvent: { upsert: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      applyVerifiedProspectEmailEventAction(
        {
          providerAccountId: 'mailbox-2',
          providerEventId: 'event-1',
          sendItemId: 'item-1',
          eventType: 'DELIVERED',
          occurredAt: new Date(),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectEmailEvent.upsert).not.toHaveBeenCalled()
  })
})
