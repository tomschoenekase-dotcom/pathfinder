import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  auditRailwayIacPlan,
  auditRailwayIacReadiness,
  EXPECTED_PLAN_FIELDS,
  EXPECTED_STAGING_BRANCH,
  EXPECTED_STAGING_PROJECT,
  MAX_RAILWAY_GRAPH_BYTES,
  parseRailwayPlanJson,
  parseRailwayGraphJson,
  REQUIRED_STAGING_RESOURCES,
} from './lib/railway-iac-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const configFiles = {
  'staging-web': 'railway.staging.web.json',
  'staging-dashboard': 'railway.staging.dashboard.json',
  'staging-workers': 'railway.staging.workers.json',
}

function completePlan() {
  const currentGraph = completeGraph()
  const desiredGraph = completeGraph()
  for (const graph of [currentGraph, desiredGraph]) {
    graph.project.name = EXPECTED_STAGING_PROJECT
    for (const service of ['staging-web', 'staging-dashboard', 'staging-workers']) {
      const resource = graph.resources.find((item) => item.name === service)
      resource.source = {
        type: 'github',
        repo: 'tomschoenekase-dotcom/pathfinder',
        branch: EXPECTED_STAGING_BRANCH,
      }
      resource.variables = { SAFE_FIXTURE: { type: 'preserve' } }
    }
  }
  const changesByService = new Map()
  for (const identity of EXPECTED_PLAN_FIELDS) {
    const [service, field] = identity.split(':')
    if (!changesByService.has(service)) changesByService.set(service, [])
    changesByService.get(service).push(`${field} (null → fixture)`)
  }
  return {
    ok: true,
    command: 'plan',
    currentEnvironment: {
      projectName: EXPECTED_STAGING_PROJECT,
      environmentName: 'staging',
    },
    changeSet: {
      changes: [...changesByService].map(([service, details]) => ({
        summary: `Update ${service} fixture`,
        severity: 'safe',
        kind: 'resource.update',
        details,
      })),
    },
    diagnostics: [],
    currentGraph,
    desiredGraph,
  }
}
const configs = Object.fromEntries(
  Object.entries(configFiles).map(([service, path]) => [
    service,
    JSON.parse(readFileSync(resolve(root, path), 'utf8')),
  ]),
)

function completeGraph() {
  const graph = {
    project: { name: EXPECTED_STAGING_PROJECT },
    resources: REQUIRED_STAGING_RESOURCES.map((name) => ({
      type: name.startsWith('staging-') ? 'service' : 'fixture-resource',
      name,
      build: configs[name]?.build,
      deploy: configs[name]?.deploy,
    })),
  }
  for (const service of ['staging-web', 'staging-dashboard', 'staging-workers']) {
    const resource = graph.resources.find((item) => item.name === service)
    resource.source = {
      type: 'github',
      repo: 'tomschoenekase-dotcom/pathfinder',
      branch: EXPECTED_STAGING_BRANCH,
    }
  }
  return graph
}

test('admits a complete graph only when every staging Config-as-Code override is represented', () => {
  const result = auditRailwayIacReadiness(completeGraph(), configs)
  assert.equal(result.migrationReady, true)
  assert.deepEqual(result.resources.missing, [])
  assert.deepEqual(result.resources.unexpected, [])
  assert.equal(result.projectMatches, true)
  assert.equal(result.sourcesMatch, true)
  assert.equal(result.preservedVariables, true)
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

test('readiness rejects extra resources, wrong sources, and literal variables', () => {
  const extra = completeGraph()
  extra.resources.push({ type: 'service', name: 'production-web' })
  assert.equal(auditRailwayIacReadiness(extra, configs).migrationReady, false)

  const wrongSource = completeGraph()
  wrongSource.resources.find((item) => item.name === 'staging-web').source.branch = 'master'
  assert.equal(auditRailwayIacReadiness(wrongSource, configs).migrationReady, false)

  const literal = completeGraph()
  literal.resources.find((item) => item.name === 'staging-web').variables = {
    SECRET: { type: 'literal', value: 'must-not-echo' },
  }
  const result = auditRailwayIacReadiness(literal, configs)
  assert.equal(result.migrationReady, false)
  assert.equal(JSON.stringify(result).includes('must-not-echo'), false)
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

test('admits only the exact safe staging IaC plan with preserved variables', () => {
  const result = auditRailwayIacPlan(completePlan(), configs)
  assert.equal(result.migrationPlanReady, true)
  assert.equal(result.safeUpdatesOnly, true)
  assert.equal(result.exactExpectedChanges, true)
  assert.equal(result.preservedVariables, true)
})

test('rejects production, destructive changes, unexpected fields, and literal variable values', () => {
  const production = completePlan()
  production.currentEnvironment.environmentName = 'production'
  assert.equal(auditRailwayIacPlan(production, configs).migrationPlanReady, false)

  const destructive = completePlan()
  destructive.changeSet.changes[0].kind = 'resource.delete'
  assert.equal(auditRailwayIacPlan(destructive, configs).migrationPlanReady, false)

  const unexpected = completePlan()
  unexpected.changeSet.changes[0].details.push('deploy.startCommand (null → fixture)')
  assert.equal(auditRailwayIacPlan(unexpected, configs).migrationPlanReady, false)

  const literal = completePlan()
  literal.desiredGraph.resources.find((item) => item.name === 'staging-web').variables = {
    UNSAFE_FIXTURE: { type: 'literal', value: 'must-not-echo' },
  }
  const result = auditRailwayIacPlan(literal, configs)
  assert.equal(result.migrationPlanReady, false)
  assert.equal(JSON.stringify(result).includes('must-not-echo'), false)
})

test('parses bounded Railway plan JSON and fails closed on malformed input', () => {
  assert.equal(parseRailwayPlanJson(JSON.stringify(completePlan())).command, 'plan')
  assert.throws(() => parseRailwayPlanJson('{'))
  assert.throws(() => parseRailwayPlanJson('{}'))
  assert.throws(() => parseRailwayPlanJson('x'.repeat(MAX_RAILWAY_GRAPH_BYTES + 1)))
})
