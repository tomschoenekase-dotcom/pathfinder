import { beforeEach, describe, expect, it, vi } from 'vitest'

const entitlement = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({ resolveProductEntitlement: entitlement }))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { locationRouter } from './location'

const queryRaw = vi.fn()
const findFirst = vi.fn()
const db = { $queryRaw: queryRaw, venueLocation: { findFirst } } as unknown as TRPCContext['db']
const caller = router({ location: locationRouter }).createCaller({
  db,
  headers: new Headers(),
  session: { userId: null, activeTenantId: null, role: null, isPlatformAdmin: false },
})
const input = {
  venueId: 'venue-1',
  anonymousToken: '123e4567-e89b-42d3-a456-426614174000',
  locationId: 'main-entrance',
}

describe('public structured location resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    entitlement.mockResolvedValue({ enabled: true })
    queryRaw.mockResolvedValue([
      { tenantId: 'tenant-1', venueId: 'venue-1', experienceScope: 'PUBLIC' },
    ])
  })

  it('returns only verified scoped data and strips unsafe external map references', async () => {
    findFirst.mockResolvedValue({
      id: 'location-1',
      stableKey: 'main-entrance',
      kind: 'ENTRANCE',
      displayName: 'Main entrance',
      description: null,
      latitude: 41.1,
      longitude: -87.1,
      mapX: null,
      mapY: null,
      externalMapReference: 'https://maps.example.test/place?api_key=secret',
      accessibilityMetadata: { stepFree: true },
      verifiedAt: new Date('2026-08-19T12:00:00Z'),
      floor: { stableKey: 'ground', name: 'Ground', level: 0 },
    })
    const result = await caller.location.resolve(input)
    expect(result).toMatchObject({
      stableKey: 'main-entrance',
      externalMapUrl: null,
      coordinates: { latitude: 41.1, longitude: -87.1 },
    })
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          visibility: 'PUBLIC',
          isActive: true,
        }),
      }),
    )
  })

  it('does not cross the public/employee boundary', async () => {
    queryRaw.mockResolvedValue([
      { tenantId: 'tenant-1', venueId: 'venue-1', experienceScope: 'SECOND_LAYER' },
    ])
    await expect(caller.location.resolve(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findFirst).not.toHaveBeenCalled()
  })

  it('fails closed when the venue lacks location entitlement', async () => {
    entitlement.mockResolvedValue({ enabled: false })
    await expect(caller.location.resolve(input)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(findFirst).not.toHaveBeenCalled()
  })
})
