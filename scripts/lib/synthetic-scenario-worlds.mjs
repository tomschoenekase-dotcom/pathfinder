import { createHash } from 'node:crypto'

import { validateDisposableDatabaseUrl } from './disposable-prisma-migration.mjs'
import { loadScenarioRegistry } from './torchiko-developer-tools.mjs'

const SCENARIO_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const DISPOSABLE_DATABASE_PATTERN = /^pathfinder_disposable_[a-z0-9_]+$/u
const RESET_OPT_IN = 'PATHFINDER_ALLOW_DISPOSABLE_SCENARIO_RESET'

export class SyntheticScenarioWorldError extends Error {
  constructor(code) {
    super(code)
    this.name = 'SyntheticScenarioWorldError'
  }
}

function fail(code) {
  throw new SyntheticScenarioWorldError(code)
}

export function parseSyntheticScenarioResetArgs(args) {
  const values = new Map()
  const scenarioId = args[0]
  if (!scenarioId || !SCENARIO_ID_PATTERN.test(scenarioId)) fail('invalid-scenario-id')

  for (let index = 1; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (option !== '--database' && option !== '--confirm-database') fail('unknown-option')
    if (values.has(option)) fail('duplicate-option')
    if (value === undefined || value.startsWith('--')) fail('missing-option-value')
    values.set(option, value)
  }

  const database = values.get('--database')
  const confirmation = values.get('--confirm-database')
  if (!database || !confirmation) fail('database-confirmation-required')
  if (database !== confirmation) fail('database-confirmation-mismatch')
  if (database.length > 63 || !DISPOSABLE_DATABASE_PATTERN.test(database)) {
    fail('invalid-disposable-database-name')
  }
  return { scenarioId, database }
}

function deterministicUuid(value) {
  const chars = createHash('sha256').update(value).digest('hex').slice(0, 32).split('')
  chars[12] = '4'
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4]
  const hex = chars.join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function stableDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function buildSyntheticScenarioWorld(scenario) {
  const tenantId = `synthetic-scenario:${scenario.id}`
  const venueId = `synthetic-venue:${scenario.id}`
  const marker = {
    schemaVersion: 1,
    synthetic: true,
    scenarioId: scenario.id,
    source: 'scripts/fixtures/agent-scenarios.json',
  }
  const locations = scenario.locations.map((location, index) => ({
    id: deterministicUuid(`${scenario.id}:${location.id}`),
    stableKey: location.id,
    displayName: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    radiusMeters: location.radiusMeters,
    kind: index === 0 ? 'ENTRANCE' : 'POI',
  }))
  const world = {
    marker,
    tenant: {
      id: tenantId,
      name: `[Synthetic] ${scenario.venue.name}`,
      slug: `synthetic-scenario-${scenario.id}`,
      config: { syntheticScenario: marker },
    },
    venue: {
      id: venueId,
      tenantId,
      name: scenario.venue.name,
      slug: `synthetic-${scenario.id}`,
      description: 'Provider-free synthetic developer scenario. Not customer data.',
      category: 'synthetic-scenario',
      defaultCenterLat: locations[0]?.latitude,
      defaultCenterLng: locations[0]?.longitude,
      geoBoundary: {
        syntheticScenario: marker,
        timezone: scenario.venue.timezone,
        weeklyHours: scenario.weeklyHours,
      },
      isActive: false,
    },
    places: locations.map((location) => ({
      id: `synthetic-place:${scenario.id}:${location.stableKey}`,
      tenantId,
      venueId,
      name: location.displayName,
      type: 'synthetic-location',
      shortDescription: `Synthetic ${location.kind.toLowerCase()} fixture.`,
      lat: location.latitude,
      lng: location.longitude,
      tags: ['synthetic', `scenario:${scenario.id}`],
      hours: JSON.stringify(scenario.weeklyHours),
      visibility: 'PUBLIC',
      sourceType: 'SYNTHETIC',
      authorship: 'AI_GENERATED',
      sourceName: marker.source,
      isActive: false,
    })),
    locations: locations.map((location) => ({
      id: location.id,
      tenantId,
      venueId,
      stableKey: location.stableKey,
      kind: location.kind,
      displayName: location.displayName,
      description: `Synthetic radius: ${location.radiusMeters} meters.`,
      visibility: 'PUBLIC',
      latitude: location.latitude,
      longitude: location.longitude,
      accessibilityMetadata: { syntheticScenario: marker },
      verifiedAt: new Date('2026-08-22T00:00:00.000Z'),
      verifiedBy: 'synthetic-scenario-reset:v1',
      isActive: false,
    })),
  }
  return { ...world, digest: stableDigest(world) }
}

function sameSet(actual, expected) {
  return actual.length === expected.length && expected.every((value) => actual.includes(value))
}

function mutableData({ id: _id, ...data }) {
  return data
}

export async function resetSyntheticScenarioWorld(client, scenario) {
  const world = buildSyntheticScenarioWorld(scenario)
  return client.$transaction(async (tx) => {
    const existing = await tx.tenant.findUnique({ where: { id: world.tenant.id } })
    if (existing) {
      const marker = existing.config?.syntheticScenario
      if (
        marker?.schemaVersion !== 1 ||
        marker?.synthetic !== true ||
        marker?.scenarioId !== scenario.id ||
        marker?.source !== world.marker.source
      ) {
        fail('existing-tenant-not-owned-by-scenario')
      }
      const [venueIds, placeIds, locationIds] = await Promise.all([
        tx.venue.findMany({ where: { tenantId: world.tenant.id }, select: { id: true } }),
        tx.place.findMany({ where: { tenantId: world.tenant.id }, select: { id: true } }),
        tx.venueLocation.findMany({
          where: { tenantId: world.tenant.id },
          select: { id: true },
        }),
      ])
      if (
        !sameSet(
          venueIds.map(({ id }) => id),
          [world.venue.id],
        )
      )
        fail('unexpected-venue-state')
      if (
        !sameSet(
          placeIds.map(({ id }) => id),
          world.places.map(({ id }) => id),
        )
      ) {
        fail('unexpected-place-state')
      }
      if (
        !sameSet(
          locationIds.map(({ id }) => id),
          world.locations.map(({ id }) => id),
        )
      ) {
        fail('unexpected-location-state')
      }
      await tx.tenant.update({
        where: { id: world.tenant.id },
        data: mutableData(world.tenant),
      })
      await tx.venue.update({
        where: { id: world.venue.id },
        data: mutableData(world.venue),
      })
      await Promise.all(
        world.places.map((place) =>
          tx.place.update({ where: { id: place.id }, data: mutableData(place) }),
        ),
      )
      await Promise.all(
        world.locations.map((location) =>
          tx.venueLocation.update({
            where: { id: location.id },
            data: mutableData(location),
          }),
        ),
      )
    } else {
      await tx.tenant.create({ data: world.tenant })
      await tx.venue.create({ data: world.venue })
      await tx.place.createMany({ data: world.places })
      await tx.venueLocation.createMany({ data: world.locations })
    }

    return {
      schemaVersion: 1,
      synthetic: true,
      providerDispatch: false,
      scenarioId: scenario.id,
      resetExisting: Boolean(existing),
      tenantId: world.tenant.id,
      venueId: world.venue.id,
      places: world.places.length,
      locations: world.locations.length,
      worldDigest: world.digest,
    }
  })
}

export async function executeSyntheticScenarioReset({
  root,
  args,
  env = process.env,
  clientFactory = async (url) => {
    const { PrismaClient } = await import('@prisma/client')
    return new PrismaClient({ datasourceUrl: url })
  },
}) {
  if (env[RESET_OPT_IN] !== '1') fail('disposable-scenario-reset-opt-in-required')
  const { scenarioId, database } = parseSyntheticScenarioResetArgs(args)
  const target = validateDisposableDatabaseUrl(env.PATHFINDER_DISPOSABLE_DATABASE_URL, database)
  const registry = await loadScenarioRegistry(root)
  if (!registry.healthy) fail('synthetic-scenario-registry-invalid')
  const scenario = registry.scenarios.find(({ id }) => id === scenarioId)
  if (!scenario) fail('unknown-synthetic-scenario')

  const client = await clientFactory(target.canonicalUrl)
  try {
    return await resetSyntheticScenarioWorld(client, scenario)
  } catch (error) {
    if (error instanceof SyntheticScenarioWorldError) throw error
    fail('scenario-reset-transaction-failed')
  } finally {
    await client.$disconnect()
  }
}
