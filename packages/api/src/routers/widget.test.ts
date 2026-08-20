import { beforeEach, describe, expect, it, vi } from 'vitest'

const entitlement = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/config/feature-flags', () => ({ isEmbedPreviewEnabled: () => true }))
vi.mock('@pathfinder/db', () => ({ resolveProductEntitlement: entitlement }))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { widgetRouter } from './widget'

const queryRaw = vi.fn()
const db = { $queryRaw: queryRaw } as unknown as TRPCContext['db']
const caller = router({ widget: widgetRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
})

describe('public widget availability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryRaw.mockResolvedValue([{ id: 'venue-1', tenantId: 'tenant-1' }])
  })

  it('returns enabled only for an active venue with the widget entitlement', async () => {
    entitlement.mockResolvedValue({ enabled: true })

    await expect(caller.widget.availability({ venueSlug: 'museum' })).resolves.toEqual({
      enabled: true,
    })
    expect(entitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        capability: 'widget',
      }),
    )
  })

  it('fails closed for missing venues and denied entitlements', async () => {
    queryRaw.mockResolvedValueOnce([])
    await expect(caller.widget.availability({ venueSlug: 'missing' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    entitlement.mockResolvedValue({ enabled: false })
    await expect(caller.widget.availability({ venueSlug: 'museum' })).resolves.toEqual({
      enabled: false,
    })
  })
})
