import { haversineDistanceMeters } from '../lib/geo'
import {
  findDeterministicRoutePlan,
  type RouteConnection,
  type RouteLocation,
} from './location-route'

type Located = RouteLocation & { latitude: number | null; longitude: number | null }

function hasCoordinates(location: Located) {
  return (
    location.latitude !== null &&
    location.longitude !== null &&
    Number.isFinite(location.latitude) &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.latitude) <= 90 &&
    Math.abs(location.longitude) <= 180
  )
}

/** Reachability comes from reviewed connections. Coordinates never create an edge or walking time. */
export function selectReachableLocation(input: {
  locations: Located[]
  connections: RouteConnection[]
  fromLocationId: string
  kind: string
  accessibleOnly: boolean
}) {
  const origin = input.locations.find((location) => location.id === input.fromLocationId)
  if (!origin) return null
  const connections = input.connections.filter(
    (connection) => !input.accessibleOnly || connection.accessible,
  )
  const candidates = input.locations
    .filter((location) => location.kind === input.kind)
    .flatMap((location) => {
      const plan = findDeterministicRoutePlan({ ...input, connections, toLocationId: location.id })
      return plan ? [{ location, plan }] : []
    })
  if (!candidates.length) return null
  // Missing coordinates on any reachable option prevent a claim that coordinate ordering is complete.
  const coordinateRanking =
    hasCoordinates(origin) && candidates.every(({ location }) => hasCoordinates(location))
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      straightLineMeters: coordinateRanking
        ? haversineDistanceMeters(
            origin.latitude!,
            origin.longitude!,
            candidate.location.latitude!,
            candidate.location.longitude!,
          )
        : null,
    }))
    .sort(
      (left, right) =>
        (left.straightLineMeters !== null && right.straightLineMeters !== null
          ? left.straightLineMeters - right.straightLineMeters
          : left.plan.steps.length - right.plan.steps.length) ||
        left.location.stableKey.localeCompare(right.location.stableKey) ||
        left.location.id.localeCompare(right.location.id),
    )
  const selected = ranked[0]!
  return {
    ...selected,
    rankingBasis: coordinateRanking
      ? ('STRAIGHT_LINE_AMONG_REACHABLE' as const)
      : ('FEWEST_REVIEWED_SEGMENTS' as const),
    reachableOptionCount: candidates.length,
    walkingDistanceMeters: null,
    walkingMinutes: null,
  }
}
