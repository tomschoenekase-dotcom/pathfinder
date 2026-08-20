import { describe, expect, it, vi } from 'vitest'

import {
  materializeOperationalEventDeliveries,
  operationalEventDestinationKey,
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
})
