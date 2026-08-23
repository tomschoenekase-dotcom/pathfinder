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
}

type RouteStep = {
  connection: RouteConnection
  fromLocationId: string
  toLocationId: string
}

export function findDeterministicRoute(input: {
  locations: RouteLocation[]
  connections: RouteConnection[]
  fromLocationId: string
  toLocationId: string
}): RouteStep[] | null {
  if (input.fromLocationId === input.toLocationId) return []

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
  const visited = new Set(queue)
  const previous = new Map<string, RouteStep>()
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]!
    for (const step of adjacency.get(current) ?? []) {
      if (visited.has(step.toLocationId)) continue
      visited.add(step.toLocationId)
      previous.set(step.toLocationId, step)
      if (step.toLocationId === input.toLocationId) {
        const route: RouteStep[] = []
        let locationId = input.toLocationId
        while (locationId !== input.fromLocationId) {
          const prior = previous.get(locationId)
          if (!prior) return null
          route.push(prior)
          locationId = prior.fromLocationId
        }
        return route.reverse()
      }
      queue.push(step.toLocationId)
    }
  }
  return null
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
