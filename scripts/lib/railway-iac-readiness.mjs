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

export function auditRailwayIacReadiness(graph, configByService) {
  if (!isRecord(graph) || !Array.isArray(graph.resources) || !isRecord(configByService)) {
    fail('invalid-railway-iac-audit-input')
  }

  const resources = new Map()
  for (const resource of graph.resources) {
    if (!isRecord(resource) || typeof resource.name !== 'string' || resources.has(resource.name)) {
      fail('invalid-railway-graph-resource')
    }
    resources.set(resource.name, resource)
  }

  const missingResources = REQUIRED_STAGING_RESOURCES.filter((name) => !resources.has(name))
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
    migrationReady: missingResources.length === 0 && unreflectedFields.length === 0,
    resources: {
      observed: resources.size,
      required: REQUIRED_STAGING_RESOURCES.length,
      missing: missingResources,
    },
    configAsCodeOverrides: {
      reflected: unreflectedFields.length === 0,
      unreflectedFields,
    },
  }
}
