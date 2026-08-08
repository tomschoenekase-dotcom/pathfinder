import { describe, expect, it, vi } from 'vitest'

import { lockVenueContentMutation, lockVenueReportMutation } from './venue-content-lock'

describe('lockVenueContentMutation', () => {
  it('binds the tenant and venue to the transaction-scoped advisory lock', async () => {
    const executeRaw = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }))

    await lockVenueContentMutation(
      { $executeRaw: executeRaw },
      { tenantId: 'tenant-a', venueId: 'venue-b' },
    )

    expect(executeRaw).toHaveBeenCalledOnce()
    const [strings, ...values] = executeRaw.mock.calls[0]!
    expect(Array.from(strings).join('?')).toContain('pg_advisory_xact_lock')
    expect(Array.from(strings).join('?')).toContain('pathfinder:venue-content:')
    expect(values).toEqual(['tenant-a', 'venue-b'])
  })
})

describe('lockVenueReportMutation', () => {
  it('derives a distinct tenant and venue scoped advisory key', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1)
    const tx = { $executeRaw: executeRaw }

    await lockVenueReportMutation(tx, { tenantId: 'tenant_1', venueId: 'venue_1' })

    expect(executeRaw).toHaveBeenCalledTimes(1)
    expect(executeRaw.mock.calls[0]?.[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtextextended(',
      ', 0))',
    ])
    expect(executeRaw.mock.calls[0]?.[1]).toBe('venue-report:tenant_1:venue_1')
  })
})
