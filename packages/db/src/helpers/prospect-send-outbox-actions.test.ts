import { describe, expect, it, vi } from 'vitest'

import {
  foldProspectEmailStatus,
  revalidateProspectSendOutboxClaimAction,
} from './prospect-send-outbox-actions'

describe('prospect provider event folding', () => {
  it.each([
    ['DELIVERED', 'SENT', 'DELIVERED'],
    ['BOUNCED', 'DELIVERED', 'BOUNCED'],
    ['COMPLAINED', 'SENT', 'COMPLAINED'],
    ['SUPPRESSED', 'DELIVERED', 'SUPPRESSED'],
    ['QUEUED', 'SENT', 'SENT'],
  ] as const)('folds %s then %s to %s', (current, incoming, expected) => {
    expect(foldProspectEmailStatus(current, incoming)).toBe(expected)
  })
})

describe('prospect last-mile delivery authority', () => {
  it('cancels a claimed operation when the emergency stop changed after claim', async () => {
    const tx = {
      prospectDeliveryControl: {
        findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: false }),
      },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-1',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
          providerAccount: {
            provider: 'GMAIL',
            capabilities: ['SEND'],
            deliveryEnabled: true,
            pausedAt: null,
            connectionStatus: 'CONNECTED',
          },
          sendItem: { id: 'item-1', batch: { campaign: { pausedAt: null, status: 'ACTIVE' } } },
        }),
        update: vi.fn(),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'CANCELLED',
          lastErrorCode: 'DELIVERY_STOPPED_BEFORE_PROVIDER',
        }),
      }),
    )
  })

  it('rejects an expired or stolen claim without mutating its new owner', async () => {
    const tx = {
      prospectDeliveryControl: { findUnique: vi.fn().mockResolvedValue({ deliveryEnabled: true }) },
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          status: 'CLAIMED',
          claimOwner: 'worker-2',
          claimExpiresAt: new Date('2026-08-22T16:05:00.000Z'),
        }),
        update: vi.fn(),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      revalidateProspectSendOutboxClaimAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBe(false)
    expect(tx.prospectSendOutbox.update).not.toHaveBeenCalled()
  })
})
