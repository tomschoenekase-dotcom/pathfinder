import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import {
  buildSyntheticScenarioWorld,
  executeSyntheticScenarioReset,
  parseSyntheticScenarioResetArgs,
  resetSyntheticScenarioWorld,
} from './lib/synthetic-scenario-worlds.mjs'
import { loadScenarioRegistry } from './lib/torchiko-developer-tools.mjs'

const root = path.resolve(import.meta.dirname, '..')
const database = 'pathfinder_disposable_scenario_worlds'
const databaseUrl = `postgresql://scenario:secret@127.0.0.1:54329/${database}`

async function scenario(id = 'small-museum') {
  const registry = await loadScenarioRegistry(root)
  return registry.scenarios.find((item) => item.id === id)
}

function clientWith(transaction) {
  let disconnected = false
  return {
    client: {
      $transaction: (callback) => callback(transaction),
      $disconnect: async () => {
        disconnected = true
      },
    },
    disconnected: () => disconnected,
  }
}

function emptyTransaction(calls) {
  return {
    tenant: {
      findUnique: async () => null,
      create: async (input) => calls.push(['tenant.create', input]),
    },
    venue: { create: async (input) => calls.push(['venue.create', input]) },
    place: { createMany: async (input) => calls.push(['place.createMany', input]) },
    venueLocation: {
      createMany: async (input) => calls.push(['venueLocation.createMany', input]),
    },
  }
}

test('reset arguments require one canonical scenario and repeated disposable database identity', () => {
  assert.deepEqual(
    parseSyntheticScenarioResetArgs([
      'small-museum',
      '--database',
      database,
      '--confirm-database',
      database,
    ]),
    { scenarioId: 'small-museum', database },
  )
  assert.throws(
    () => parseSyntheticScenarioResetArgs(['../museum', '--database', database]),
    /invalid-scenario-id/u,
  )
  assert.throws(
    () =>
      parseSyntheticScenarioResetArgs([
        'small-museum',
        '--database',
        database,
        '--confirm-database',
        'pathfinder_disposable_other',
      ]),
    /database-confirmation-mismatch/u,
  )
  assert.throws(
    () =>
      parseSyntheticScenarioResetArgs([
        'small-museum',
        '--database',
        'production',
        '--confirm-database',
        'production',
      ]),
    /invalid-disposable-database-name/u,
  )
})

test('all canonical scenarios compile to deterministic inactive non-customer worlds', async () => {
  const registry = await loadScenarioRegistry(root)
  const worlds = registry.scenarios.map(buildSyntheticScenarioWorld)
  assert.equal(worlds.length, 4)
  assert.equal(new Set(worlds.map(({ digest }) => digest)).size, 4)
  for (const [index, world] of worlds.entries()) {
    assert.equal(world.digest, buildSyntheticScenarioWorld(registry.scenarios[index]).digest)
    assert.equal(world.marker.synthetic, true)
    assert.equal(world.venue.isActive, false)
    assert.ok(world.places.every((place) => !place.isActive && place.visibility === 'PUBLIC'))
    assert.ok(
      world.locations.every((location) => !location.isActive && location.visibility === 'PUBLIC'),
    )
  }
})

test('a first reset creates the exact canonical tenant, venue, places, and anchors', async () => {
  const calls = []
  const runtime = clientWith(emptyTransaction(calls))
  const result = await resetSyntheticScenarioWorld(runtime.client, await scenario())
  assert.equal(result.resetExisting, false)
  assert.equal(result.providerDispatch, false)
  assert.deepEqual(
    calls.map(([operation]) => operation),
    ['tenant.create', 'venue.create', 'place.createMany', 'venueLocation.createMany'],
  )
  assert.equal(calls[2][1].data.length, 2)
  assert.equal(calls[3][1].data.length, 2)
})

test('an owned exact world restores current state without deleting immutable history', async () => {
  const canonical = buildSyntheticScenarioWorld(await scenario())
  const calls = []
  const transaction = {
    tenant: {
      findUnique: async () => ({ id: canonical.tenant.id, config: canonical.tenant.config }),
      update: async (input) => calls.push(['tenant.update', input]),
    },
    venue: {
      findMany: async () => [{ id: canonical.venue.id }],
      update: async (input) => calls.push(['venue.update', input]),
    },
    place: {
      findMany: async () => canonical.places.map(({ id }) => ({ id })),
      update: async (input) => calls.push(['place.update', input]),
    },
    venueLocation: {
      findMany: async () => canonical.locations.map(({ id }) => ({ id })),
      update: async (input) => calls.push(['venueLocation.update', input]),
    },
  }
  const result = await resetSyntheticScenarioWorld(clientWith(transaction).client, await scenario())
  assert.equal(result.resetExisting, true)
  assert.deepEqual(
    calls.map(([operation]) => operation),
    [
      'tenant.update',
      'venue.update',
      'place.update',
      'place.update',
      'venueLocation.update',
      'venueLocation.update',
    ],
  )
})

test('a colliding tenant without the exact marker is refused before mutation', async () => {
  let mutated = false
  const transaction = emptyTransaction([])
  transaction.tenant.findUnique = async () => ({ id: 'collision', config: {} })
  transaction.tenant.create = async () => {
    mutated = true
  }
  await assert.rejects(
    resetSyntheticScenarioWorld(clientWith(transaction).client, await scenario()),
    /existing-tenant-not-owned-by-scenario/u,
  )
  assert.equal(mutated, false)
})

test('unexpected core rows refuse reset before any current-state update', async () => {
  const canonical = buildSyntheticScenarioWorld(await scenario())
  let mutated = false
  const transaction = {
    tenant: {
      findUnique: async () => ({ id: canonical.tenant.id, config: canonical.tenant.config }),
      update: async () => {
        mutated = true
      },
    },
    venue: { findMany: async () => [{ id: canonical.venue.id }] },
    place: {
      findMany: async () => [...canonical.places.map(({ id }) => ({ id })), { id: 'foreign' }],
    },
    venueLocation: {
      findMany: async () => canonical.locations.map(({ id }) => ({ id })),
    },
  }
  await assert.rejects(
    resetSyntheticScenarioWorld(clientWith(transaction).client, await scenario()),
    /unexpected-place-state/u,
  )
  assert.equal(mutated, false)
})

test('execution refuses before client creation unless the exact disposable opt-in is present', async () => {
  let created = false
  await assert.rejects(
    executeSyntheticScenarioReset({
      root,
      args: ['small-museum', '--database', database, '--confirm-database', database],
      env: { PATHFINDER_DISPOSABLE_DATABASE_URL: databaseUrl },
      clientFactory: () => {
        created = true
      },
    }),
    /disposable-scenario-reset-opt-in-required/u,
  )
  assert.equal(created, false)
})

test('execution pins the canonical loopback URL and always disconnects', async () => {
  const calls = []
  const runtime = clientWith(emptyTransaction(calls))
  let connectedUrl
  const result = await executeSyntheticScenarioReset({
    root,
    args: ['small-museum', '--database', database, '--confirm-database', database],
    env: {
      PATHFINDER_ALLOW_DISPOSABLE_SCENARIO_RESET: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: databaseUrl,
    },
    clientFactory: (url) => {
      connectedUrl = url
      return runtime.client
    },
  })
  assert.equal(connectedUrl, databaseUrl)
  assert.equal(result.scenarioId, 'small-museum')
  assert.equal(runtime.disconnected(), true)
  assert.doesNotMatch(JSON.stringify(result), /secret/u)
})
