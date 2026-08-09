import { describe, expect, it, vi } from 'vitest'

import { assertVenueAvailable, VenueUnavailableError } from './venue-availability'

describe('venue availability', () => {
  it('admits only the exact active tenant venue', async () => {
    const findFirst = vi.fn().mockResolvedValue({ isActive: true })

    await expect(
      assertVenueAvailable({ venue: { findFirst } } as never, {
        tenantId: 'tenant_1',
        venueId: 'venue_1',
      }),
    ).resolves.toBeUndefined()
    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'venue_1', tenantId: 'tenant_1' },
      select: { isActive: true },
    })
  })

  it.each([null, { isActive: false }])(
    'fails closed for missing or inactive venues',
    async (row) => {
      await expect(
        assertVenueAvailable({ venue: { findFirst: vi.fn().mockResolvedValue(row) } } as never, {
          tenantId: 'tenant_1',
          venueId: 'venue_1',
        }),
      ).rejects.toBeInstanceOf(VenueUnavailableError)
    },
  )

  it('normalizes availability-store failure into admission deferral', async () => {
    await expect(
      assertVenueAvailable(
        {
          venue: { findFirst: vi.fn().mockRejectedValue(new Error('database unavailable')) },
        } as never,
        { tenantId: 'tenant_1', venueId: 'venue_1' },
      ),
    ).rejects.toBeInstanceOf(VenueUnavailableError)
  })
})
