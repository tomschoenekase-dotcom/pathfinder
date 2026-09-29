import { beforeEach, describe, expect, it, vi } from 'vitest'

const distribution = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({ resolveCachedVenueDistribution: distribution }))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { widgetRouter } from './widget'

const db = {} as unknown as TRPCContext['db']
const caller = router({ widget: widgetRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
})

describe('public widget availability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    distribution.mockResolvedValue({ website: { effective: true, framed: true } })
  })

  it('returns enabled only for an active venue with the widget entitlement', async () => {
    await expect(caller.widget.availability({ venueSlug: 'museum' })).resolves.toEqual({
      enabled: true,
    })
    expect(distribution).toHaveBeenCalledWith({ client: db, venueSlug: 'museum' })
  })

  it('fails closed for missing venues and denied entitlements', async () => {
    distribution.mockResolvedValueOnce(null)
    await expect(caller.widget.availability({ venueSlug: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    distribution.mockResolvedValueOnce({ website: { effective: false, framed: false } })
    await expect(caller.widget.availability({ venueSlug: 'museum' })).resolves.toEqual({
      enabled: false,
    })
  })
})
