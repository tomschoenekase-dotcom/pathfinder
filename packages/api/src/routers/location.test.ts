import { beforeEach, describe, expect, it, vi } from 'vitest'

const entitlement = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({ resolveProductEntitlement: entitlement }))

import type { TRPCContext } from '../context'
import { router } from '../core'
import { locationRouter } from './location'

const queryRaw = vi.fn()
const findFirst = vi.fn()
const findMany = vi.fn()
const connectionFindMany = vi.fn()
const db = {
  $queryRaw: queryRaw,
  venueLocation: { findFirst, findMany },
  venueLocationConnection: { findMany: connectionFindMany },
} as unknown as TRPCContext['db']
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
const routeInput = {
  venueId: input.venueId,
  anonymousToken: input.anonymousToken,
  fromLocationId: 'entrance',
  toLocationId: 'gallery',
}
const locations = [
  {
    id: 'location-entrance',
    stableKey: 'entrance',
    kind: 'ENTRANCE',
    displayName: 'Entrance',
    floor: { id: 'floor-1', stableKey: 'ground', name: 'Ground', level: 0 },
  },
  {
    id: 'location-alpha',
    stableKey: 'alpha-hall',
    kind: 'ZONE',
    displayName: 'Alpha hall',
    floor: { id: 'floor-1', stableKey: 'ground', name: 'Ground', level: 0 },
  },
  {
    id: 'location-beta',
    stableKey: 'beta-hall',
    kind: 'ZONE',
    displayName: 'Beta hall',
    floor: { id: 'floor-1', stableKey: 'ground', name: 'Ground', level: 0 },
  },
  {
    id: 'location-gallery',
    stableKey: 'gallery',
    kind: 'EXHIBIT',
    displayName: 'Gallery',
    floor: { id: 'floor-2', stableKey: 'upper', name: 'Upper', level: 1 },
  },
]

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

  it('returns a deterministic shortest route through reviewed public topology', async () => {
    findMany.mockResolvedValue(locations)
    connectionFindMany.mockResolvedValue([
      {
        id: 'connection-beta-2',
        fromLocationId: 'location-beta',
        toLocationId: 'location-gallery',
        kind: 'STAIRS',
        bidirectional: true,
        accessible: false,
        directions: 'Continue upstairs.',
      },
      {
        id: 'connection-alpha-1',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-alpha',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Take Alpha hall.',
      },
      {
        id: 'connection-beta-1',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-beta',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Take Beta hall.',
      },
      {
        id: 'connection-alpha-2',
        fromLocationId: 'location-alpha',
        toLocationId: 'location-gallery',
        kind: 'ELEVATOR',
        bidirectional: true,
        accessible: true,
        directions: 'Use the elevator.',
      },
    ])

    const result = await caller.location.route(routeInput)
    expect(result).toMatchObject({
      from: { stableKey: 'entrance' },
      to: { stableKey: 'gallery' },
      accessibleOnly: false,
      segmentCount: 2,
      segments: [
        { connectionId: 'connection-alpha-1', to: { stableKey: 'alpha-hall' } },
        { connectionId: 'connection-alpha-2', to: { stableKey: 'gallery' } },
      ],
    })
  })

  it('lists only the reviewed public route catalog projection', async () => {
    findMany.mockResolvedValue(locations)

    const result = await caller.location.catalog({
      venueId: routeInput.venueId,
      anonymousToken: routeInput.anonymousToken,
    })

    expect(result.locations).toEqual([
      {
        id: 'location-entrance',
        stableKey: 'entrance',
        kind: 'ENTRANCE',
        displayName: 'Entrance',
        floor: { stableKey: 'ground', name: 'Ground', level: 0 },
      },
      expect.any(Object),
      expect.any(Object),
      expect.any(Object),
    ])
    expect(result.locations[0]).not.toHaveProperty('tenantId')
    expect(result.locations[0]?.floor).not.toHaveProperty('id')
  })

  it('filters the graph to explicitly accessible connections when requested', async () => {
    findMany.mockResolvedValue(locations)
    connectionFindMany.mockResolvedValue([
      {
        id: 'connection-alpha-1',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-alpha',
        kind: 'ELEVATOR',
        bidirectional: true,
        accessible: true,
        directions: null,
      },
      {
        id: 'connection-alpha-2',
        fromLocationId: 'location-alpha',
        toLocationId: 'location-gallery',
        kind: 'ELEVATOR',
        bidirectional: true,
        accessible: true,
        directions: null,
      },
    ])

    const result = await caller.location.route({ ...routeInput, accessibleOnly: true })
    expect(result.segmentCount).toBe(2)
    expect(result.segments.every((segment) => segment.accessible)).toBe(true)
    expect(connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ accessible: true }) }),
    )
  })

  it('respects one-way connections and reveals no private endpoint existence', async () => {
    findMany.mockResolvedValue(locations)
    connectionFindMany.mockResolvedValue([
      {
        id: 'connection-one-way',
        fromLocationId: 'location-gallery',
        toLocationId: 'location-entrance',
        kind: 'SHUTTLE',
        bidirectional: false,
        accessible: true,
        directions: 'Outbound shuttle only.',
      },
    ])

    await expect(caller.location.route(routeInput)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('fails closed before loading connections when the public topology is oversized', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        ...locations[0],
        id: `location-${index}`,
        stableKey: `location-${index}`,
      })),
    )
    await expect(caller.location.route(routeInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(connectionFindMany).not.toHaveBeenCalled()
  })
})
