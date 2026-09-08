import { describe, expect, it } from 'vitest'
import { selectReachableLocation } from './location-reachable'

const location = (id: string, latitude: number | null, kind = 'RESTROOM') => ({
  id,
  stableKey: id,
  displayName: id,
  kind,
  latitude,
  longitude: 0,
  floor: null,
})
const edge = (fromLocationId: string, toLocationId: string, accessible = true) => ({
  id: `${fromLocationId}-${toLocationId}`,
  fromLocationId,
  toLocationId,
  kind: 'WALKWAY',
  bidirectional: false,
  accessible,
  directions: 'Reviewed walkway',
  verifiedAt: new Date('2026-09-07T00:00:00Z'),
})
const input = {
  locations: [location('start', 0, 'ENTRANCE'), location('near', 0.0001), location('far', 0.001)],
  connections: [edge('start', 'far')],
  fromLocationId: 'start',
  kind: 'RESTROOM',
  accessibleOnly: false,
}

describe('reviewed reachable destination selection', () => {
  it('selects the reachable restroom over the closer disconnected coordinate', () => {
    expect(selectReachableLocation(input)).toMatchObject({
      location: { id: 'far' },
      rankingBasis: 'STRAIGHT_LINE_AMONG_REACHABLE',
      reachableOptionCount: 1,
      walkingDistanceMeters: null,
      walkingMinutes: null,
    })
  })
  it('respects accessibility and one-way edges before distance ranking', () => {
    const connections = [edge('start', 'near', false), edge('start', 'far')]
    expect(selectReachableLocation({ ...input, connections })?.location.id).toBe('near')
    expect(
      selectReachableLocation({ ...input, connections, accessibleOnly: true })?.location.id,
    ).toBe('far')
    expect(selectReachableLocation({ ...input, connections: [edge('near', 'start')] })).toBeNull()
  })
  it('cannot substitute co-location for a reviewed route', () => {
    expect(
      selectReachableLocation({
        ...input,
        locations: [location('start', 0, 'ENTRANCE'), location('near', 0)],
        connections: [],
      }),
    ).toBeNull()
  })
  it('falls back explicitly when any reachable destination lacks coordinates', () => {
    expect(
      selectReachableLocation({
        ...input,
        locations: [
          location('start', 0, 'ENTRANCE'),
          location('near', null),
          location('far', 0.001),
        ],
        connections: [edge('start', 'near'), edge('near', 'far')],
      }),
    ).toMatchObject({
      location: { id: 'near' },
      rankingBasis: 'FEWEST_REVIEWED_SEGMENTS',
      straightLineMeters: null,
    })
  })
  it('does not use invalid origin coordinates or invent an origin', () => {
    expect(
      selectReachableLocation({
        ...input,
        locations: [location('start', Number.NaN, 'ENTRANCE'), location('far', 1)],
      })?.straightLineMeters,
    ).toBeNull()
    expect(selectReachableLocation({ ...input, fromLocationId: 'missing' })).toBeNull()
  })
  it('recognizes a destination at the explicitly selected start', () => {
    expect(selectReachableLocation({ ...input, fromLocationId: 'near' })).toMatchObject({
      location: { id: 'near' },
      plan: { steps: [] },
    })
  })
  it('does not select a closed origin as an already-here destination', () => {
    expect(
      selectReachableLocation({
        ...input,
        fromLocationId: 'near',
        unavailableDestinationIds: ['near'],
      }),
    ).toBeNull()
  })
})
