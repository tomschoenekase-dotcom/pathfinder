import { describe, expect, it, vi } from 'vitest'

import {
  claimProspectSendOutboxAction,
  foldProspectEmailStatus,
  recordProspectSendFailureAction,
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

describe('prospect send claim rate reservation', () => {
  it('serializes the send lane and defers an operation when a configured cap is exhausted', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          operationId: '00000000-0000-0000-0000-000000000001',
          providerAccountId: 'mailbox-1',
          status: 'PENDING',
          availableAt: new Date('2026-08-22T15:00:00.000Z'),
          claimOwner: null,
          claimExpiresAt: null,
          providerAccount: {
            dailySendCap: 0,
            perDomainDailyCap: 2,
            minimumDelaySeconds: 180,
            jitterSeconds: 0,
          },
          sendItem: {
            recipientEmailSnapshot: 'venue@example.com',
            batch: { campaignId: 'campaign-1', campaign: { dailySendCap: 10 } },
          },
        }),
        count: vi.fn().mockResolvedValue(0),
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany,
      },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      claimProspectSendOutboxAction(
        {
          outboxId: 'outbox-1',
          workerId: 'worker-1',
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).resolves.toBeNull()
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(updateMany).toHaveBeenCalledOnce()
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETRYABLE',
          availableAt: new Date('2026-08-23T00:00:00.000Z'),
          lastErrorCode: 'DAILY_CAP',
        }),
      }),
    )
  })
})

describe('prospect send lease completion', () => {
  it('rejects a stale worker completion without changing the send item', async () => {
    const tx = {
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          sendItem: { id: 'item-1', batchId: 'batch-1' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = { $transaction: vi.fn((work) => work(tx)) }
    await expect(
      recordProspectSendFailureAction(
        {
          outboxId: 'outbox-1',
          workerId: 'stale-worker',
          code: 'TRANSIENT',
          retryable: true,
          acceptanceAmbiguous: false,
          now: new Date('2026-08-22T16:00:00.000Z'),
        },
        client as never,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'CLAIMED',
          claimOwner: 'stale-worker',
          claimExpiresAt: { gt: new Date('2026-08-22T16:00:00.000Z') },
        }),
      }),
    )
    expect(tx.prospectSendItem.update).not.toHaveBeenCalled()
  })

  it('derives durable failure detail from the bounded code', async () => {
    const tx = {
      prospectSendOutbox: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'outbox-1',
          sendItem: { id: 'item-1', batchId: 'batch-1' },
        }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      prospectSendItem: { update: vi.fn() },
    }
    const client = {
      $transaction: vi.fn((work) => work(tx)),
      prospectSendBatch: {
        findUnique: vi.fn().mockResolvedValue({ id: 'batch-1' }),
        update: vi.fn(),
      },
      prospectSendItem: {
        count: vi.fn().mockResolvedValue(0),
      },
    }
    await recordProspectSendFailureAction(
      {
        outboxId: 'outbox-1',
        workerId: 'worker-1',
        code: 'TRANSIENT',
        retryable: true,
        acceptanceAmbiguous: false,
        now: new Date('2026-08-22T16:00:00.000Z'),
      },
      client as never,
    )
    const expected = {
      lastErrorCode: 'TRANSIENT',
      lastErrorMessage: 'Prospect delivery failed (TRANSIENT).',
    }
    expect(tx.prospectSendOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expected) }),
    )
    expect(tx.prospectSendItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining(expected) }),
    )
  })
})
