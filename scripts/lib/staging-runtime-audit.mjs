const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_LOG_BYTES = 1_048_576
const MAX_LINES = 200

const SERVICE_OPTIONS = [
  ['--web-deployment', 'staging-web'],
  ['--dashboard-deployment', 'staging-dashboard'],
  ['--workers-deployment', 'staging-workers'],
]

export class StagingRuntimeAuditError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StagingRuntimeAuditError'
    this.code = code
  }
}

function fail(code) {
  throw new StagingRuntimeAuditError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function parseStagingRuntimeArgs(args) {
  if (args.length !== 8) fail('invalid-options')
  const deployments = {}
  for (let index = 0; index < SERVICE_OPTIONS.length; index += 1) {
    const [option, service] = SERVICE_OPTIONS[index]
    const offset = index * 2
    if (args[offset] !== option || !UUID.test(args[offset + 1] ?? '')) fail('invalid-options')
    deployments[service] = args[offset + 1]
  }
  if (args[6] !== '--since' || args[7] !== '24h') fail('invalid-options')
  return { deployments, since: '24h' }
}

export function buildRuntimeLogQueries({ deployments, since }) {
  const queries = []
  for (const [, service] of SERVICE_OPTIONS) {
    const deploymentId = deployments[service]
    if (!UUID.test(deploymentId ?? '') || since !== '24h') fail('invalid-options')
    queries.push({
      key: `${service}:errors`,
      service,
      args: [
        'logs',
        deploymentId,
        '--service',
        service,
        '--environment',
        'staging',
        '--since',
        since,
        '--lines',
        String(MAX_LINES),
        '--filter',
        '@level:error',
        '--json',
      ],
    })
  }
  for (const service of ['staging-web', 'staging-dashboard']) {
    queries.push({
      key: `${service}:http5xx`,
      service,
      args: [
        'logs',
        deployments[service],
        '--service',
        service,
        '--environment',
        'staging',
        '--http',
        '--status',
        '500..599',
        '--since',
        since,
        '--lines',
        String(MAX_LINES),
        '--json',
      ],
    })
  }
  queries.push({
    key: 'staging-workers:events',
    service: 'staging-workers',
    args: [
      'logs',
      deployments['staging-workers'],
      '--service',
      'staging-workers',
      '--environment',
      'staging',
      '--since',
      since,
      '--lines',
      String(MAX_LINES),
      '--json',
    ],
  })
  return queries
}

export function parseBoundedLogLines(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_LOG_BYTES) {
    fail('invalid-log-output')
  }
  if (text.trim() === '') return []
  return text
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => {
      try {
        const value = JSON.parse(line)
        if (!isRecord(value)) fail('invalid-log-json')
        return value
      } catch (error) {
        if (error instanceof StagingRuntimeAuditError) throw error
        fail('invalid-log-json')
      }
    })
}

export function auditStagingRuntime(options, runRailway) {
  if (typeof runRailway !== 'function') fail('invalid-runner')
  const queryResults = new Map()
  for (const query of buildRuntimeLogQueries(options)) {
    const result = runRailway(query.args)
    if (!isRecord(result) || result.status !== 0 || typeof result.stdout !== 'string') {
      fail('railway-query-failed')
    }
    queryResults.set(query.key, parseBoundedLogLines(result.stdout))
  }

  const services = {}
  for (const [, service] of SERVICE_OPTIONS) {
    services[service] = { errorRows: queryResults.get(`${service}:errors`).length }
  }
  services['staging-web'].http5xxRows = queryResults.get('staging-web:http5xx').length
  services['staging-dashboard'].http5xxRows = queryResults.get('staging-dashboard:http5xx').length

  const workerEvents = queryResults.get('staging-workers:events')
  const retained = workerEvents.filter(
    (row) => row.action === 'workers.founder-absence-observation.retained',
  )
  const failed = workerEvents.filter(
    (row) => row.action === 'workers.founder-absence-observation.failed',
  )
  const latest = retained.at(-1) ?? null
  const founderAbsence = {
    retainedEvents: retained.length,
    failedEvents: failed.length,
    latestObservedOn:
      latest && /^\d{4}-\d{2}-\d{2}$/u.test(latest.observedOn) ? latest.observedOn : null,
    latestEvidenceComplete: latest?.evidenceComplete === true,
  }

  if (Object.values(services).some((service) => service.errorRows > 0)) {
    fail('runtime-error-rows')
  }
  if (services['staging-web'].http5xxRows > 0 || services['staging-dashboard'].http5xxRows > 0) {
    fail('runtime-http-5xx')
  }
  if (failed.length > 0) fail('founder-absence-capture-failed')

  return { ok: true, environment: 'staging', window: '24h', services, founderAbsence }
}
