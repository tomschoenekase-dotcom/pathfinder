import { describe, expect, it, vi } from 'vitest'

vi.mock('../grants', () => ({
  assertVenueInGrant: vi.fn(async () => undefined),
  OperatorNotFoundError: class OperatorNotFoundError extends Error {},
}))

import { updateReadTools } from './updates'

const row = (over: Record<string, unknown>) => ({
  id: 'u1',
  placeId: null,
  updateType: 'GENERAL_NOTICE',
  severity: 'INFO',
  priority: 'NORMAL',
  title: 'Notice',
  body: null,
  redirectTo: null,
  startsAt: new Date('2026-07-01T05:00:00Z'),
  expiresAt: new Date('2026-07-08T05:00:00Z'),
  status: 'PUBLISHED',
  isActive: true,
  updatedAt: new Date('2026-07-01T05:00:00Z'),
  ...over,
})

describe('venues.list_operational_updates lifecycle', () => {
  it('returns computed lifecycle and flags active-but-expired next to raw fields', async () => {
    const tool = updateReadTools.find((t) => t.name === 'venues.list_operational_updates')!
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row({ id: 'expired' }),
        row({ id: 'ended', isActive: false }),
        row({ id: 'live', expiresAt: new Date('2026-12-01T00:00:00Z') }),
      ])
    const result = (await tool.handler({ tenantId: 'tenant_1', venueId: 'venue_1', limit: 10 }, {
      now: new Date('2026-10-02T12:00:00Z'),
      grant: {},
      database: {
        operationalUpdate: { findMany, findFirst: vi.fn() },
        venue: { findFirst: vi.fn() },
      },
    } as never)) as { items: Array<Record<string, unknown>> }
    const byId = Object.fromEntries(result.items.map((item) => [item.updateId, item]))
    expect(byId.expired).toMatchObject({
      isActive: true,
      lifecycle: 'EXPIRED',
      guestVisibleNow: false,
      isActiveButExpired: true,
    })
    expect(String(byId.expired?.lifecycleLabel)).toMatch(/expired/i)
    expect(byId.ended).toMatchObject({ lifecycle: 'ENDED', isActiveButExpired: false })
    expect(byId.live).toMatchObject({ lifecycle: 'LIVE', guestVisibleNow: true })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 'tenant_1' }) }),
    )
  })
})
