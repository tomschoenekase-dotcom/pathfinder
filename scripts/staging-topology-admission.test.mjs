import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

import {
  parseBoundedTopologyJson,
  parseStagingTopologyArgs,
  validateStagingTopology,
} from './lib/staging-topology-admission.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const DIGEST = `sha256:${'c'.repeat(64)}`
const IDS = {
  'staging-web': '11111111-1111-4111-8111-111111111111',
  'staging-dashboard': '22222222-2222-4222-8222-222222222222',
  'staging-workers': '33333333-3333-4333-8333-333333333333',
}

function deployment(serviceName, overrides = {}) {
  return {
    id: IDS[serviceName],
    status: 'SUCCESS',
    deploymentStopped: false,
    instances: [{ id: 'instance', status: 'RUNNING' }],
    meta: { commitHash: SHA, imageDigest: DIGEST },
    ...overrides,
  }
}

function service(serviceName, overrides = {}) {
  return {
    node: {
      serviceName,
      latestDeployment: deployment(serviceName),
      ...overrides,
    },
  }
}

function topology(serviceEdges = Object.keys(IDS).map((name) => service(name))) {
  return {
    environments: {
      edges: [
        {
          node: {
            name: 'staging',
            serviceInstances: {
              edges: [...serviceEdges, service('Redis-5Vrb', { latestDeployment: null })],
            },
          },
        },
      ],
    },
  }
}

test('admits exactly one live web, dashboard, and worker deployment at the expected revision', () => {
  const payload = topology()
  payload.environments.edges[0].node.serviceInstances.edges[0].node.latestDeployment.instances.push(
    {
      id: 'removed',
      status: 'REMOVED',
    },
  )

  const result = validateStagingTopology(payload, SHA)
  assert.equal(result.ok, true)
  assert.equal(result.environment, 'staging')
  assert.equal(result.revision, SHA)
  assert.deepEqual(Object.keys(result.services), Object.keys(IDS))
  assert.equal(result.services['staging-workers'].instanceStatus, 'RUNNING')
})

test('rejects missing or duplicate application services and staging environments', () => {
  assert.throws(
    () => validateStagingTopology(topology([service('staging-web')]), SHA),
    /service-count/u,
  )
  assert.throws(
    () =>
      validateStagingTopology(
        topology([...Object.keys(IDS).map((name) => service(name)), service('staging-workers')]),
        SHA,
      ),
    /service-count/u,
  )
  const duplicateEnvironment = topology()
  duplicateEnvironment.environments.edges.push(duplicateEnvironment.environments.edges[0])
  assert.throws(() => validateStagingTopology(duplicateEnvironment, SHA), /environment-count/u)
})

test('rejects revision drift, inactive deployments, missing running instances, and unsafe statuses', () => {
  const cases = [
    deployment('staging-workers', { meta: { commitHash: OTHER_SHA, imageDigest: DIGEST } }),
    deployment('staging-workers', { status: 'FAILED' }),
    deployment('staging-workers', { deploymentStopped: true }),
    deployment('staging-workers', { instances: [{ id: 'removed', status: 'REMOVED' }] }),
    deployment('staging-workers', { instances: [{ id: 'crashed', status: 'CRASHED' }] }),
    deployment('staging-workers', { meta: { commitHash: SHA, imageDigest: 'latest' } }),
  ]
  for (const candidate of cases) {
    const services = Object.keys(IDS).map((name) =>
      name === 'staging-workers' ? service(name, { latestDeployment: candidate }) : service(name),
    )
    assert.throws(() => validateStagingTopology(topology(services), SHA))
  }
})

test('parses one exact revision option and bounded JSON only', () => {
  assert.deepEqual(parseStagingTopologyArgs(['--expected-revision', SHA]), {
    expectedRevision: SHA,
  })
  for (const args of [
    [],
    ['--revision', SHA],
    ['--expected-revision', 'main'],
    ['--expected-revision', SHA, '--extra', 'x'],
  ]) {
    assert.throws(() => parseStagingTopologyArgs(args))
  }
  assert.deepEqual(parseBoundedTopologyJson(JSON.stringify(topology())), topology())
  assert.throws(() => parseBoundedTopologyJson(''))
  assert.throws(() => parseBoundedTopologyJson('{invalid'))
  assert.throws(() => parseBoundedTopologyJson('x'.repeat(1_048_577)))
})

test('CLI emits only bounded admitted topology and contains malformed input', () => {
  const admitted = spawnSync(
    process.execPath,
    ['scripts/verify-staging-topology.mjs', '--expected-revision', SHA],
    { input: JSON.stringify(topology()), encoding: 'utf8' },
  )
  assert.equal(admitted.status, 0)
  assert.equal(JSON.parse(admitted.stdout).revision, SHA)
  assert.equal(admitted.stderr, '')

  const refused = spawnSync(
    process.execPath,
    ['scripts/verify-staging-topology.mjs', '--expected-revision', SHA],
    { input: '{private malformed detail', encoding: 'utf8' },
  )
  assert.equal(refused.status, 1)
  assert.equal(refused.stdout, '')
  assert.equal(refused.stderr, 'Staging topology admission failed: invalid-topology-json\n')
  assert.doesNotMatch(refused.stderr, /private malformed detail/u)
})
