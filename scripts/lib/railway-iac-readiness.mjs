export const MAX_RAILWAY_GRAPH_BYTES = 1_048_576

export const REQUIRED_STAGING_RESOURCES = [
  'Redis-5Vrb',
  'clamav',
  'pgvector',
  'pgvector-volume',
  'redis-volume-Pu8X',
  'reserved-tote',
  'staging-dashboard',
  'staging-web',
  'staging-workers',
]

export const EXPECTED_STAGING_PROJECT = 'serene-inspiration'
export const EXPECTED_STAGING_BRANCH = 'codex/pathfinder-v2-staging'
export const EXPECTED_PLAN_FIELDS = [
  'staging-dashboard:build.builder',
  'staging-dashboard:deploy.restartPolicyMaxRetries',
  'staging-dashboard:deploy.restartPolicyType',
  'staging-web:build.builder',
  'staging-web:build.dockerfilePath',
  'staging-web:deploy.healthcheckPath',
  'staging-web:deploy.preDeployCommand',
  'staging-web:deploy.restartPolicyMaxRetries',
  'staging-web:deploy.restartPolicyType',
  'staging-workers:build.builder',
  'staging-workers:build.dockerfilePath',
  'staging-workers:deploy.restartPolicyMaxRetries',
  'staging-workers:deploy.restartPolicyType',
]

export class RailwayIacReadinessError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new RailwayIacReadinessError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function parseRailwayGraphJson(text) {
  if (typeof text !== 'string') fail('invalid-railway-graph-input')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes === 0 || bytes > MAX_RAILWAY_GRAPH_BYTES) fail('invalid-railway-graph-input')
  try {
    const graph = JSON.parse(text)
    if (!isRecord(graph) || !Array.isArray(graph.resources)) fail('invalid-railway-graph-shape')
    return graph
  } catch (error) {
    if (error instanceof RailwayIacReadinessError) throw error
    fail('invalid-railway-graph-json')
  }
}

export function parseRailwayPlanJson(text) {
  if (typeof text !== 'string') fail('invalid-railway-plan-input')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes === 0 || bytes > MAX_RAILWAY_GRAPH_BYTES) fail('invalid-railway-plan-input')
  try {
    const plan = JSON.parse(text)
    if (!isRecord(plan) || !isRecord(plan.changeSet)) fail('invalid-railway-plan-shape')
    return plan
  } catch (error) {
    if (error instanceof RailwayIacReadinessError) throw error
    fail('invalid-railway-plan-json')
  }
}

function resourceMap(graph) {
  if (!isRecord(graph) || !Array.isArray(graph.resources)) fail('invalid-railway-graph-shape')
  const resources = new Map()
  for (const resource of graph.resources) {
    if (!isRecord(resource) || typeof resource.name !== 'string' || resources.has(resource.name)) {
      fail('invalid-railway-graph-resource')
    }
    resources.set(resource.name, resource)
  }
  return resources
}

function variablesArePreserved(resource) {
  if (resource.variables === null || resource.variables === undefined) return true
  if (!isRecord(resource.variables)) return false
  return Object.values(resource.variables).every(
    (variable) =>
      isRecord(variable) && Object.keys(variable).length === 1 && variable.type === 'preserve',
  )
}

export function auditRailwayIacPlan(plan, configByService) {
  if (!isRecord(plan) || !isRecord(plan.currentEnvironment) || !isRecord(plan.changeSet)) {
    fail('invalid-railway-iac-plan-input')
  }
  if (!Array.isArray(plan.changeSet.changes) || !Array.isArray(plan.diagnostics)) {
    fail('invalid-railway-iac-plan-input')
  }

  const desiredAudit = auditRailwayIacReadiness(plan.desiredGraph, configByService)
  const current = resourceMap(plan.currentGraph)
  const desired = resourceMap(plan.desiredGraph)
  const resourceNamesMatch =
    current.size === REQUIRED_STAGING_RESOURCES.length &&
    desired.size === REQUIRED_STAGING_RESOURCES.length &&
    REQUIRED_STAGING_RESOURCES.every((name) => current.has(name) && desired.has(name))

  const sourceServices = ['staging-web', 'staging-dashboard', 'staging-workers']
  const sourcesMatch = sourceServices.every((name) => {
    const source = desired.get(name)?.source
    return (
      isRecord(source) &&
      source.type === 'github' &&
      source.repo === 'tomschoenekase-dotcom/pathfinder' &&
      source.branch === EXPECTED_STAGING_BRANCH
    )
  })

  const preservedVariables = [...desired.values()].every(variablesArePreserved)
  const observedFields = []
  let safeUpdatesOnly = true
  for (const change of plan.changeSet.changes) {
    if (
      !isRecord(change) ||
      change.kind !== 'resource.update' ||
      change.severity !== 'safe' ||
      typeof change.summary !== 'string' ||
      !Array.isArray(change.details)
    ) {
      safeUpdatesOnly = false
      continue
    }
    const service = change.summary.match(/^Update ([^ ]+) /)?.[1]
    if (!service) {
      safeUpdatesOnly = false
      continue
    }
    for (const detail of change.details) {
      const field = typeof detail === 'string' ? detail.match(/^([^ ]+) \(/)?.[1] : undefined
      if (!field) safeUpdatesOnly = false
      else observedFields.push(`${service}:${field}`)
    }
  }
  observedFields.sort()
  const expectedFields = [...EXPECTED_PLAN_FIELDS].sort()
  const exactExpectedChanges = sameValue(observedFields, expectedFields)

  const projectAndEnvironmentMatch =
    plan.ok === true &&
    plan.command === 'plan' &&
    plan.currentEnvironment.projectName === EXPECTED_STAGING_PROJECT &&
    plan.currentEnvironment.environmentName === 'staging' &&
    plan.currentGraph?.project?.name === EXPECTED_STAGING_PROJECT &&
    plan.desiredGraph?.project?.name === EXPECTED_STAGING_PROJECT
  const diagnosticsClear = plan.diagnostics.length === 0
  const migrationPlanReady =
    projectAndEnvironmentMatch &&
    diagnosticsClear &&
    resourceNamesMatch &&
    sourcesMatch &&
    preservedVariables &&
    desiredAudit.migrationReady &&
    safeUpdatesOnly &&
    exactExpectedChanges

  return {
    ok: true,
    environment: 'staging',
    migrationPlanReady,
    projectAndEnvironmentMatch,
    diagnosticsClear,
    resourceNamesMatch,
    sourcesMatch,
    preservedVariables,
    desiredConfigComplete: desiredAudit.migrationReady,
    safeUpdatesOnly,
    exactExpectedChanges,
    observedChangeFields: observedFields,
  }
}

export function auditRailwayIacReadiness(graph, configByService) {
  if (!isRecord(graph) || !Array.isArray(graph.resources) || !isRecord(configByService)) {
    fail('invalid-railway-iac-audit-input')
  }

  const resources = resourceMap(graph)

  const missingResources = REQUIRED_STAGING_RESOURCES.filter((name) => !resources.has(name))
  const unexpectedResources = [...resources.keys()].filter(
    (name) => !REQUIRED_STAGING_RESOURCES.includes(name),
  )
  const projectMatches =
    (graph.project?.name ?? graph.name) === EXPECTED_STAGING_PROJECT
  const sourceServices = ['staging-web', 'staging-dashboard', 'staging-workers']
  const sourcesMatch = sourceServices.every((name) => {
    const source = resources.get(name)?.source
    return (
      isRecord(source) &&
      source.type === 'github' &&
      source.repo === 'tomschoenekase-dotcom/pathfinder' &&
      source.branch === EXPECTED_STAGING_BRANCH
    )
  })
  const preservedVariables = [...resources.values()].every(variablesArePreserved)
  const unreflectedFields = []

  for (const [service, desired] of Object.entries(configByService)) {
    const observed = resources.get(service)
    if (!observed || observed.type !== 'service' || !isRecord(desired)) continue

    for (const section of ['build', 'deploy']) {
      const desiredSection = desired[section]
      if (!isRecord(desiredSection)) continue
      const observedSection = isRecord(observed[section]) ? observed[section] : {}
      for (const [field, value] of Object.entries(desiredSection)) {
        if (!sameValue(observedSection[field], value)) {
          unreflectedFields.push({ service, field: `${section}.${field}` })
        }
      }
    }
  }

  return {
    ok: true,
    environment: 'staging',
    migrationReady:
      missingResources.length === 0 &&
      unexpectedResources.length === 0 &&
      projectMatches &&
      sourcesMatch &&
      preservedVariables &&
      unreflectedFields.length === 0,
    projectMatches,
    sourcesMatch,
    preservedVariables,
    resources: {
      observed: resources.size,
      required: REQUIRED_STAGING_RESOURCES.length,
      missing: missingResources,
      unexpected: unexpectedResources,
    },
    configAsCodeOverrides: {
      reflected: unreflectedFields.length === 0,
      unreflectedFields,
    },
  }
}
