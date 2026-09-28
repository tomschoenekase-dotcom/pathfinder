import { STAGING_RELEASE_TARGET } from '../lib/staging-release-admission.mjs'

const FULL_SHA = /^[0-9a-f]{40}$/u
const DEPLOYMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PENDING_STATES = new Set(['QUEUED', 'BUILDING', 'DEPLOYING', 'INITIALIZING', 'WAITING'])
const FAILED_STATES = new Set(['FAILED', 'CRASHED', 'CANCELLED', 'REMOVED'])
const DEFAULT_MAX_POLLS = 20
const DEFAULT_POLL_INTERVAL_MS = 5_000

export const STAGING_DEPLOY_TARGET = Object.freeze({
  projectId: STAGING_RELEASE_TARGET.projectId,
  environmentId: STAGING_RELEASE_TARGET.environmentId,
})

export const STAGING_DEPLOY_SERVICES = Object.freeze({
  'staging-web': STAGING_RELEASE_TARGET.services['staging-web'],
  'staging-dashboard': STAGING_RELEASE_TARGET.services['staging-dashboard'],
  'staging-workers': STAGING_RELEASE_TARGET.services['staging-workers'],
})

const SERVICE_CONFIG = Object.freeze({
  'staging-web': Object.freeze({
    configFile: 'railway.staging.web.json',
    readback: 'http-health',
    healthPath: '/api/health',
  }),
  'staging-dashboard': Object.freeze({
    configFile: 'railway.staging.dashboard.json',
    readback: 'railway-instance',
  }),
  'staging-workers': Object.freeze({
    configFile: 'railway.staging.workers.json',
    readback: 'railway-instance',
  }),
})

/**
 * Held until the owner verifies an exact Railway mutation command and a readback contract.
 * This module has no CLI or API implementation and cannot perform a real deployment.
 */
export const RAILWAY_DEPLOYMENT_PROVIDER_BINDING = Object.freeze({
  available: false,
  state: 'held',
  reason: 'unverified-provider-mutation-command',
})

export class StagingDeployError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StagingDeployError'
    this.code = code
  }
}

function fail(code) {
  throw new StagingDeployError(code)
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertMockAdapter(adapter) {
  if (
    !isObject(adapter) ||
    adapter.kind !== 'mock' ||
    typeof adapter.readTarget !== 'function' ||
    typeof adapter.deploy !== 'function' ||
    typeof adapter.readDeployment !== 'function' ||
    typeof adapter.readHealth !== 'function'
  ) {
    fail('railway-provider-binding-held')
  }
}

async function callAdapter(adapter, method, request, errorCode) {
  try {
    return await adapter[method](request)
  } catch {
    fail(errorCode)
  }
}

function assertTarget(target) {
  if (
    !isObject(target) ||
    target.projectId !== STAGING_DEPLOY_TARGET.projectId ||
    target.environmentId !== STAGING_DEPLOY_TARGET.environmentId ||
    !isObject(target.services)
  ) {
    fail('staging-target-identity-mismatch')
  }

  const actualNames = Object.keys(target.services).sort()
  const expectedNames = Object.keys(STAGING_DEPLOY_SERVICES).sort()
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index]) ||
    expectedNames.some((name) => target.services[name] !== STAGING_DEPLOY_SERVICES[name])
  ) {
    fail('staging-target-identity-mismatch')
  }
}

function assertDeploymentIdentity(value, expected) {
  if (
    !isObject(value) ||
    value.projectId !== expected.projectId ||
    value.environmentId !== expected.environmentId ||
    value.serviceId !== expected.serviceId ||
    value.deploymentId !== expected.deploymentId
  ) {
    fail('deployment-identity-mismatch')
  }
}

/**
 * Run the same-SHA state machine against an explicitly marked mock adapter only.
 * The adapter must implement Railway operations; the production binding is deliberately held.
 */
export async function runStagingDeploy({
  releaseSha,
  adapter,
  maxPolls = DEFAULT_MAX_POLLS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (typeof releaseSha !== 'string' || !FULL_SHA.test(releaseSha)) {
    fail('invalid-release-sha')
  }
  if (
    !Number.isSafeInteger(maxPolls) ||
    maxPolls < 1 ||
    maxPolls > 60 ||
    !Number.isSafeInteger(pollIntervalMs) ||
    pollIntervalMs < 0 ||
    pollIntervalMs > 30_000 ||
    typeof sleep !== 'function'
  ) {
    fail('invalid-wait-policy')
  }
  assertMockAdapter(adapter)

  const target = await callAdapter(adapter, 'readTarget', {}, 'staging-target-read-failed')
  assertTarget(target)

  const services = {}
  for (const [serviceName, serviceId] of Object.entries(STAGING_DEPLOY_SERVICES)) {
    const config = SERVICE_CONFIG[serviceName]
    const request = {
      projectId: STAGING_DEPLOY_TARGET.projectId,
      environmentId: STAGING_DEPLOY_TARGET.environmentId,
      serviceName,
      serviceId,
      configFile: config.configFile,
      releaseSha,
    }
    const started = await callAdapter(adapter, 'deploy', request, 'deployment-request-failed')
    if (!isObject(started) || typeof started.deploymentId !== 'string' || !DEPLOYMENT_ID.test(started.deploymentId)) {
      fail('invalid-deployment-id')
    }

    const expected = {
      projectId: STAGING_DEPLOY_TARGET.projectId,
      environmentId: STAGING_DEPLOY_TARGET.environmentId,
      serviceId,
      deploymentId: started.deploymentId,
    }
    let completed = false
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      const deployment = await callAdapter(
        adapter,
        'readDeployment',
        { ...expected, serviceName },
        'deployment-read-failed',
      )
      assertDeploymentIdentity(deployment, expected)
      if (deployment.sourceSha != null && deployment.sourceSha !== releaseSha) {
        fail('deployment-revision-mismatch')
      }
      if (deployment.status === 'SUCCESS') {
        if (deployment.sourceSha !== releaseSha) fail('deployment-revision-mismatch')
        completed = true
        break
      }
      if (FAILED_STATES.has(deployment.status)) fail('deployment-failed')
      if (!PENDING_STATES.has(deployment.status)) fail('deployment-state-unrecognized')
      if (attempt + 1 < maxPolls) {
        try {
          await sleep(pollIntervalMs)
        } catch {
          fail('deployment-wait-failed')
        }
      }
    }
    if (!completed) fail('deployment-timeout')

    services[serviceName] = {
      serviceId,
      deploymentId: started.deploymentId,
      revision: releaseSha,
      readback: config.readback,
      ...(config.healthPath ? { healthPath: config.healthPath } : {}),
    }
  }

  for (const [serviceName, service] of Object.entries(services)) {
    const health = await callAdapter(
      adapter,
      'readHealth',
      {
        projectId: STAGING_DEPLOY_TARGET.projectId,
        environmentId: STAGING_DEPLOY_TARGET.environmentId,
        serviceName,
        serviceId: service.serviceId,
        deploymentId: service.deploymentId,
        expectedRevision: releaseSha,
        readback: service.readback,
        ...(service.healthPath ? { healthPath: service.healthPath } : {}),
      },
      'health-readback-failed',
    )
    assertDeploymentIdentity(health, {
      projectId: STAGING_DEPLOY_TARGET.projectId,
      environmentId: STAGING_DEPLOY_TARGET.environmentId,
      serviceId: service.serviceId,
      deploymentId: service.deploymentId,
    })
    if (health.healthy !== true || health.revision !== releaseSha) {
      fail('health-readback-failed')
    }
    service.healthy = true
  }

  return {
    ok: true,
    environment: 'staging',
    revision: releaseSha,
    target: STAGING_DEPLOY_TARGET,
    services,
    providerBinding: RAILWAY_DEPLOYMENT_PROVIDER_BINDING.state,
  }
}
