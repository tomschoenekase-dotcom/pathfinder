export type RouteLocation = {
  id: string
  stableKey: string
  kind: string
  displayName: string
  floor: { id: string; stableKey: string; name: string; level: number | null } | null
}

export type RouteConnection = {
  id: string
  fromLocationId: string
  toLocationId: string
  kind: string
  bidirectional: boolean
  accessible: boolean
  directions: string | null
  verifiedAt: Date
}

type RouteStep = {
  connection: RouteConnection
  fromLocationId: string
  toLocationId: string
}

export type DeterministicRoutePlan = {
  steps: RouteStep[]
  hasEquivalentRoute: boolean
}

function hasReviewedDirections(connection: RouteConnection) {
  return Boolean(connection.directions?.trim())
}

function compareCandidatePaths(
  left: { steps: RouteStep[]; describedSegments: number; signature: string },
  right: { steps: RouteStep[]; describedSegments: number; signature: string },
) {
  return (
    right.describedSegments - left.describedSegments ||
    left.signature.localeCompare(right.signature)
  )
}

export function findDeterministicRoutePlan(input: {
  locations: RouteLocation[]
  connections: RouteConnection[]
  fromLocationId: string
  toLocationId: string
}): DeterministicRoutePlan | null {
  if (input.fromLocationId === input.toLocationId) return { steps: [], hasEquivalentRoute: false }

  const locationById = new Map(input.locations.map((location) => [location.id, location]))
  if (!locationById.has(input.fromLocationId) || !locationById.has(input.toLocationId)) return null

  const adjacency = new Map<string, RouteStep[]>()
  const addStep = (step: RouteStep) => {
    const steps = adjacency.get(step.fromLocationId) ?? []
    steps.push(step)
    adjacency.set(step.fromLocationId, steps)
  }
  for (const connection of input.connections) {
    if (!locationById.has(connection.fromLocationId) || !locationById.has(connection.toLocationId))
      continue
    addStep({
      connection,
      fromLocationId: connection.fromLocationId,
      toLocationId: connection.toLocationId,
    })
    if (connection.bidirectional) {
      addStep({
        connection,
        fromLocationId: connection.toLocationId,
        toLocationId: connection.fromLocationId,
      })
    }
  }
  for (const steps of adjacency.values()) {
    steps.sort((left, right) => {
      const leftLocation = locationById.get(left.toLocationId)!
      const rightLocation = locationById.get(right.toLocationId)!
      return (
        leftLocation.stableKey.localeCompare(rightLocation.stableKey) ||
        left.connection.kind.localeCompare(right.connection.kind) ||
        left.connection.id.localeCompare(right.connection.id)
      )
    })
  }

  const queue = [input.fromLocationId]
  const distance = new Map([[input.fromLocationId, 0]])
  const shortestPathCount = new Map([[input.fromLocationId, 1]])
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!
    const nextDistance = distance.get(current)! + 1
    for (const step of adjacency.get(current) ?? []) {
      const knownDistance = distance.get(step.toLocationId)
      if (knownDistance === undefined) {
        distance.set(step.toLocationId, nextDistance)
        shortestPathCount.set(step.toLocationId, shortestPathCount.get(current) ?? 1)
        queue.push(step.toLocationId)
      } else if (knownDistance === nextDistance) {
        shortestPathCount.set(
          step.toLocationId,
          Math.min(
            2,
            (shortestPathCount.get(step.toLocationId) ?? 0) + (shortestPathCount.get(current) ?? 1),
          ),
        )
      }
    }
  }

  const targetDistance = distance.get(input.toLocationId)
  if (targetDistance === undefined) return null

  const bestPath = new Map<
    string,
    { steps: RouteStep[]; describedSegments: number; signature: string }
  >([[input.fromLocationId, { steps: [], describedSegments: 0, signature: '' }]])
  const orderedLocations = [...input.locations].sort(
    (left, right) =>
      (distance.get(left.id) ?? Number.POSITIVE_INFINITY) -
        (distance.get(right.id) ?? Number.POSITIVE_INFINITY) ||
      left.stableKey.localeCompare(right.stableKey) ||
      left.id.localeCompare(right.id),
  )
  for (const location of orderedLocations) {
    const currentPath = bestPath.get(location.id)
    const currentDistance = distance.get(location.id)
    if (!currentPath || currentDistance === undefined || currentDistance >= targetDistance) continue
    for (const step of adjacency.get(location.id) ?? []) {
      if (distance.get(step.toLocationId) !== currentDistance + 1) continue
      const toLocation = locationById.get(step.toLocationId)!
      const signature = `${currentPath.signature}|${toLocation.stableKey}:${step.connection.kind}:${step.connection.id}`
      const candidate = {
        steps: [...currentPath.steps, step],
        describedSegments:
          currentPath.describedSegments + (hasReviewedDirections(step.connection) ? 1 : 0),
        signature,
      }
      const existing = bestPath.get(step.toLocationId)
      if (!existing || compareCandidatePaths(candidate, existing) < 0) {
        bestPath.set(step.toLocationId, candidate)
      }
    }
  }

  const selected = bestPath.get(input.toLocationId)
  if (!selected) return null
  return {
    steps: selected.steps,
    hasEquivalentRoute: (shortestPathCount.get(input.toLocationId) ?? 0) > 1,
  }
}

export function findDeterministicRoute(input: {
  locations: RouteLocation[]
  connections: RouteConnection[]
  fromLocationId: string
  toLocationId: string
}): RouteStep[] | null {
  return findDeterministicRoutePlan(input)?.steps ?? null
}

export function projectRouteLocation(location: RouteLocation) {
  return {
    id: location.id,
    stableKey: location.stableKey,
    kind: location.kind,
    displayName: location.displayName,
    floor: location.floor
      ? {
          stableKey: location.floor.stableKey,
          name: location.floor.name,
          level: location.floor.level,
        }
      : null,
  }
}
