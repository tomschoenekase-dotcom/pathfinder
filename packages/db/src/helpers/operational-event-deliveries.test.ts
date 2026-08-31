import { describe, expect, it, vi } from 'vitest'

import {
  materializeOperationalEventDeliveries,
  operationalEventDestinationKey,
  recordOperationalEventDeliveryAttempt,
} from './operational-event-deliveries'

describe('operational event delivery routing', () => {
  it('uses an opaque stable destination key and materializes only severity-matched events', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'event-1', tenantId: 'tenant-1' }])
    const upsert = vi.fn().mockResolvedValue({ id: 'delivery-1' })
    const policy = {
      channel: 'EMAIL' as const,
      destination: 'operator@example.test',
      minimumSeverity: 'ERROR' as const,
    }
    const result = await materializeOperationalEventDeliveries(policy, {
      operationalEvent: { findMany },
      operationalEventDelivery: { upsert },
    } as never)

    expect(result).toEqual({
      destinationKey: operationalEventDestinationKey(policy),
      created: 1,
    })
    expect(JSON.stringify(result)).not.toContain(policy.destination)
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ severity: { in: ['ERROR', 'CRITICAL'] } }),
        take: 100,
      }),
    )
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ tenantId: 'tenant-1', channel: 'EMAIL' }),
      }),
    )
  })

  it('rejects unknown channels and malformed destinations', async () => {
    await expect(
      materializeOperationalEventDeliveries(
        { channel: 'SMS', destination: '', minimumSeverity: 'INFO' } as never,
        {} as never,
      ),
    ).rejects.toThrow()
  })

  it('rejects unknown failure codes and inconsistent retry state before a transaction', async () => {
    const transaction = vi.fn()
    await expect(
      recordOperationalEventDeliveryAttempt(
        {
          deliveryId: 'delivery-1',
          tenantId: 'tenant-1',
          attemptNumber: 1,
          status: 'FAILED',
          provider: 'test-provider',
          errorCode: 'UPSTREAM_SECRET_TOKEN',
          nextAttemptAt: new Date(),
        } as never,
        { $transaction: transaction } as never,
      ),
    ).rejects.toThrow()
    await expect(
      recordOperationalEventDeliveryAttempt(
        {
          deliveryId: 'delivery-1',
          tenantId: 'tenant-1',
          attemptNumber: 1,
          status: 'FAILED',
          provider: 'test-provider',
          errorCode: 'PROVIDER_FAILURE',
        } as never,
        { $transaction: transaction } as never,
      ),
    ).rejects.toThrow()
    expect(transaction).not.toHaveBeenCalled()
  })

  it('persists the admitted retry code and schedule together', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'attempt-1' })
    const update = vi.fn().mockResolvedValue({ id: 'delivery-1' })
    const transaction = vi.fn(async (operation) =>
      operation({
        operationalEventDeliveryAttempt: { create },
        operationalEventDelivery: { update },
      }),
    )
    const nextAttemptAt = new Date('2026-08-31T00:05:00Z')
    await recordOperationalEventDeliveryAttempt(
      {
        deliveryId: 'delivery-1',
        tenantId: 'tenant-1',
        attemptNumber: 2,
        status: 'FAILED',
        provider: 'test-provider',
        errorCode: 'PROVIDER_FAILURE',
        nextAttemptAt,
      },
      { $transaction: transaction } as never,
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorCode: 'PROVIDER_FAILURE' }) }),
    )
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastErrorCode: 'PROVIDER_FAILURE',
          nextAttemptAt,
        }),
      }),
    )
  })
})
