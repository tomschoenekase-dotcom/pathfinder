import { beforeEach, describe, expect, it, vi } from 'vitest'

const entitlement = vi.hoisted(() => vi.fn())
const routeEligibility = vi.hoisted(() => vi.fn())
vi.mock('@pathfinder/db', () => ({ resolveProductEntitlement: entitlement }))
vi.mock('../lib/media-relation-route-loader', () => ({
  filterEligibleMediaRouteConnections: routeEligibility,
}))

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
const reachableInput = {
  venueId: input.venueId,
  anonymousToken: input.anonymousToken,
  fromLocationId: 'entrance',
  kind: 'RESTROOM' as const,
  accessibleOnly: false,
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
    routeEligibility.mockImplementation(async ({ connections }) => connections)
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
        verifiedAt: new Date('2026-08-18T12:00:00Z'),
      },
      {
        id: 'connection-alpha-1',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-alpha',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Take Alpha hall.',
        verifiedAt: new Date('2026-08-17T12:00:00Z'),
      },
      {
        id: 'connection-beta-1',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-beta',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Take Beta hall.',
        verifiedAt: new Date('2026-08-19T12:00:00Z'),
      },
      {
        id: 'connection-alpha-2',
        fromLocationId: 'location-alpha',
        toLocationId: 'location-gallery',
        kind: 'ELEVATOR',
        bidirectional: true,
        accessible: true,
        directions: null,
        verifiedAt: new Date('2026-08-20T12:00:00Z'),
      },
    ])

    const result = await caller.location.route(routeInput)
    expect(result).toMatchObject({
      from: { stableKey: 'entrance' },
      to: { stableKey: 'gallery' },
      accessibleOnly: false,
      segmentCount: 2,
      describedSegmentCount: 2,
      guidanceConfidence: 'HIGH',
      hasEquivalentRoute: true,
      review: {
        status: 'VENUE_REVIEWED',
        reviewedAt: new Date('2026-08-18T12:00:00Z'),
      },
      segments: [
        { connectionId: 'connection-beta-1', to: { stableKey: 'beta-hall' } },
        { connectionId: 'connection-beta-2', to: { stableKey: 'gallery' } },
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

  it('returns an empty optional catalog without disclosing an unavailable public scope', async () => {
    queryRaw.mockResolvedValueOnce([])

    await expect(
      caller.location.catalog({
        venueId: routeInput.venueId,
        anonymousToken: routeInput.anonymousToken,
      }),
    ).resolves.toEqual({ locations: [] })
    expect(entitlement).not.toHaveBeenCalled()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('returns an empty optional catalog when location guidance is not entitled', async () => {
    entitlement.mockResolvedValueOnce({ enabled: false })

    await expect(
      caller.location.catalog({
        venueId: routeInput.venueId,
        anonymousToken: routeInput.anonymousToken,
      }),
    ).resolves.toEqual({ locations: [] })
    expect(findMany).not.toHaveBeenCalled()
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
        verifiedAt: new Date('2026-08-18T12:00:00Z'),
      },
      {
        id: 'connection-alpha-2',
        fromLocationId: 'location-alpha',
        toLocationId: 'location-gallery',
        kind: 'ELEVATOR',
        bidirectional: true,
        accessible: true,
        directions: null,
        verifiedAt: new Date('2026-08-17T12:00:00Z'),
      },
    ])

    const result = await caller.location.route({ ...routeInput, accessibleOnly: true })
    expect(result.segmentCount).toBe(2)
    expect(result).toMatchObject({
      describedSegmentCount: 0,
      guidanceConfidence: 'LIMITED',
      hasEquivalentRoute: false,
      review: { status: 'VENUE_REVIEWED', reviewedAt: new Date('2026-08-17T12:00:00Z') },
    })
    expect(result.segments.every((segment) => segment.accessible)).toBe(true)
    expect(connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ accessible: true }) }),
    )
  })

  it('rejects identical route endpoints before loading connections', async () => {
    findMany.mockResolvedValue(locations)

    await expect(
      caller.location.route({
        ...routeInput,
        toLocationId: routeInput.fromLocationId,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(connectionFindMany).not.toHaveBeenCalled()
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
        verifiedAt: new Date('2026-08-19T12:00:00Z'),
      },
    ])

    await expect(caller.location.route(routeInput)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not route through a media connection whose source review was withdrawn', async () => {
    findMany.mockResolvedValue(locations)
    connectionFindMany.mockResolvedValue([
      {
        id: 'connection-media',
        fromLocationId: 'location-entrance',
        toLocationId: 'location-gallery',
        kind: 'DOOR',
        bidirectional: true,
        accessible: true,
        directions: 'Use the reviewed door.',
        verifiedAt: new Date('2026-08-19T12:00:00Z'),
        _count: { mediaRelationApplications: 1 },
      },
    ])
    routeEligibility.mockResolvedValueOnce([])
    await expect(caller.location.route(routeInput)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(routeEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    )
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

  it('resolves visitor scope and entitlement before reading reachable topology', async () => {
    findMany.mockResolvedValue([
      locations[0],
      { ...locations[1], id: 'restroom', stableKey: 'restroom', kind: 'RESTROOM' },
    ])
    connectionFindMany.mockResolvedValue([])

    await expect(caller.location.reachableDestination(reachableInput)).resolves.toEqual({
      destination: null,
      ranking: null,
    })

    expect(entitlement).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        venueId: 'venue-1',
        capability: 'location-plus',
      }),
    )
    expect(queryRaw.mock.invocationCallOrder[0]!).toBeLessThan(
      entitlement.mock.invocationCallOrder[0]!,
    )
    expect(entitlement.mock.invocationCallOrder[0]!).toBeLessThan(
      findMany.mock.invocationCallOrder[0]!,
    )
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          venueId: 'venue-1',
          visibility: 'PUBLIC',
          isActive: true,
        }),
        take: 501,
      }),
    )
  })

  it('selects a reachable restroom rather than a nearer disconnected coordinate', async () => {
    findMany.mockResolvedValue([
      { ...locations[0], latitude: 41, longitude: -87 },
      {
        ...locations[1],
        id: 'restroom-near',
        stableKey: 'restroom-near',
        displayName: 'Near disconnected restroom',
        kind: 'RESTROOM',
        latitude: 41.00001,
        longitude: -87,
      },
      {
        ...locations[2],
        id: 'restroom-far',
        stableKey: 'restroom-far',
        displayName: 'Far reachable restroom',
        kind: 'RESTROOM',
        latitude: 41.001,
        longitude: -87,
      },
    ])
    connectionFindMany.mockResolvedValue([
      {
        id: 'connection-restroom',
        fromLocationId: 'location-entrance',
        toLocationId: 'restroom-far',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: 'Follow the reviewed corridor.',
        verifiedAt: new Date('2026-09-07T00:00:00Z'),
        _count: { mediaRelationApplications: 0 },
      },
    ])

    const result = await caller.location.reachableDestination(reachableInput)
    expect(result).toMatchObject({
      destination: { id: 'restroom-far', stableKey: 'restroom-far' },
      ranking: {
        basis: 'STRAIGHT_LINE_AMONG_REACHABLE',
        reachableOptionCount: 1,
        reviewedSegmentCount: 1,
        walkingDistanceMeters: null,
        walkingMinutes: null,
      },
    })
  })

  it('removes a media-derived destination when its source review loses eligibility', async () => {
    findMany.mockResolvedValue([
      locations[0],
      { ...locations[1], id: 'restroom', stableKey: 'restroom', kind: 'RESTROOM' },
    ])
    connectionFindMany.mockResolvedValue([
      {
        id: 'media-restroom-route',
        fromLocationId: 'location-entrance',
        toLocationId: 'restroom',
        kind: 'DOOR',
        bidirectional: true,
        accessible: true,
        directions: 'Use the reviewed door.',
        verifiedAt: new Date('2026-09-07T00:00:00Z'),
        _count: { mediaRelationApplications: 1 },
      },
    ])
    routeEligibility.mockResolvedValueOnce([])

    await expect(caller.location.reachableDestination(reachableInput)).resolves.toEqual({
      destination: null,
      ranking: null,
    })
    expect(routeEligibility).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', venueId: 'venue-1' }),
    )
  })

  it('requires explicitly accessible connections when accessibleOnly is requested', async () => {
    findMany.mockResolvedValue([
      locations[0],
      { ...locations[1], id: 'restroom', stableKey: 'restroom', kind: 'RESTROOM' },
    ])
    connectionFindMany.mockResolvedValue([])

    await expect(
      caller.location.reachableDestination({ ...reachableInput, accessibleOnly: true }),
    ).resolves.toEqual({ destination: null, ranking: null })
    expect(connectionFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ accessible: true }) }),
    )
  })

  it('does not disclose an unknown or non-public origin and returns null for no candidate', async () => {
    findMany.mockResolvedValue(locations)
    await expect(caller.location.reachableDestination(reachableInput)).resolves.toEqual({
      destination: null,
      ranking: null,
    })
    expect(connectionFindMany).toHaveBeenCalledOnce()

    connectionFindMany.mockClear()
    await expect(
      caller.location.reachableDestination({ ...reachableInput, fromLocationId: 'private-room' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(connectionFindMany).not.toHaveBeenCalled()
  })

  it('fails closed at both bounded topology caps', async () => {
    findMany.mockResolvedValue(
      Array.from({ length: 501 }, (_, index) => ({
        ...locations[0],
        id: `location-${index}`,
        stableKey: index === 0 ? 'entrance' : `location-${index}`,
      })),
    )
    await expect(caller.location.reachableDestination(reachableInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
    expect(connectionFindMany).not.toHaveBeenCalled()

    findMany.mockResolvedValue(locations)
    connectionFindMany.mockResolvedValue(
      Array.from({ length: 1001 }, (_, index) => ({
        id: `connection-${index}`,
        fromLocationId: 'location-entrance',
        toLocationId: 'location-gallery',
        kind: 'WALKWAY',
        bidirectional: true,
        accessible: true,
        directions: null,
        verifiedAt: new Date('2026-09-07T00:00:00Z'),
        _count: { mediaRelationApplications: 0 },
      })),
    )
    await expect(caller.location.reachableDestination(reachableInput)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    })
  })
})
