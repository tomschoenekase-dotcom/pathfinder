import { describe, expect, it, vi } from 'vitest'

import { lockVenueContentMutation } from './venue-content-lock'

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
