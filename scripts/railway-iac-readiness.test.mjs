import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditRailwayIacReadiness,
  MAX_RAILWAY_GRAPH_BYTES,
  parseRailwayGraphJson,
  REQUIRED_STAGING_RESOURCES,
} from './lib/railway-iac-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configFiles = {
  'staging-web': 'railway.staging.web.json',
  'staging-dashboard': 'railway.staging.dashboard.json',
  'staging-workers': 'railway.staging.workers.json',
}
const configs = Object.fromEntries(
  Object.entries(configFiles).map(([service, path]) => [
    service,
    JSON.parse(readFileSync(resolve(root, path), 'utf8')),
  ]),
)

function completeGraph() {
  return {
    project: { name: 'fixture' },
    resources: REQUIRED_STAGING_RESOURCES.map((name) => ({
      type: name.startsWith('staging-') ? 'service' : 'fixture-resource',
      name,
      build: configs[name]?.build,
      deploy: configs[name]?.deploy,
    })),
  }
}

test('admits a complete graph only when every staging Config-as-Code override is represented', () => {
  const result = auditRailwayIacReadiness(completeGraph(), configs)
  assert.equal(result.migrationReady, true)
  assert.deepEqual(result.resources.missing, [])
  assert.deepEqual(result.configAsCodeOverrides.unreflectedFields, [])
})

test('reports only bounded field identities when pulled dashboard state omits code overrides', () => {
  const graph = completeGraph()
  const web = graph.resources.find((resource) => resource.name === 'staging-web')
  web.build = { builder: 'RAILPACK' }
  web.deploy = { runtime: 'V2' }
  const result = auditRailwayIacReadiness(graph, configs)
  assert.equal(result.migrationReady, false)
  assert.deepEqual(result.configAsCodeOverrides.unreflectedFields, [
    { service: 'staging-web', field: 'build.builder' },
    { service: 'staging-web', field: 'build.dockerfilePath' },
    { service: 'staging-web', field: 'deploy.preDeployCommand' },
    { service: 'staging-web', field: 'deploy.healthcheckPath' },
    { service: 'staging-web', field: 'deploy.restartPolicyType' },
    { service: 'staging-web', field: 'deploy.restartPolicyMaxRetries' },
  ])
  assert.equal(JSON.stringify(result).includes('migration/scripts'), false)
})

test('fails closed on missing resources, duplicate names, malformed input, and oversized input', () => {
  const graph = completeGraph()
  graph.resources.pop()
  assert.equal(auditRailwayIacReadiness(graph, configs).migrationReady, false)
  assert.throws(() =>
    auditRailwayIacReadiness(
      { ...graph, resources: [...graph.resources, graph.resources[0]] },
      configs,
    ),
  )
  assert.throws(() => parseRailwayGraphJson('{'))
  assert.throws(() => parseRailwayGraphJson('x'.repeat(MAX_RAILWAY_GRAPH_BYTES + 1)))
})

test('CLI returns two for a valid but incomplete migration graph without echoing variables', () => {
  const graph = completeGraph()
  graph.resources.find((resource) => resource.name === 'staging-dashboard').build = {
    builder: 'RAILPACK',
  }
  graph.resources[0].variables = { SECRET_MARKER: 'must-not-echo' }
  const result = spawnSync(process.execPath, ['scripts/verify-railway-iac-readiness.mjs'], {
    cwd: root,
    encoding: 'utf8',
    input: JSON.stringify(graph),
  })
  assert.equal(result.status, 2)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout.includes('must-not-echo'), false)
  assert.equal(JSON.parse(result.stdout).migrationReady, false)
})
