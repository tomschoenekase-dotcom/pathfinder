import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RAILWAY_DEPLOYMENT_PROVIDER_BINDING,
  STAGING_DEPLOY_SERVICES,
  STAGING_DEPLOY_TARGET,
  runStagingDeploy,
} from './railway-deploy.mjs'

const sha = 'a'.repeat(40)
const deploymentIds = {
  'staging-web': '11111111-1111-4111-8111-111111111111',
  'staging-dashboard': '22222222-2222-4222-8222-222222222222',
  'staging-workers': '33333333-3333-4333-8333-333333333333',
}
const serviceOrder = Object.keys(STAGING_DEPLOY_SERVICES)

function createAdapter(overrides = {}) {
  const calls = []
  const deployRequests = []
  const adapter = {
    kind: 'mock',
    async readTarget() {
      calls.push(['readTarget'])
      return {
        projectId: STAGING_DEPLOY_TARGET.projectId,
        environmentId: STAGING_DEPLOY_TARGET.environmentId,
        services: { ...STAGING_DEPLOY_SERVICES },
      }
    },
    async deploy(request) {
      calls.push(['deploy', request.serviceName, request.releaseSha])
      deployRequests.push({ ...request })
      return { deploymentId: deploymentIds[request.serviceName] }
    },
    async readDeployment(request) {
      calls.push(['readDeployment', request.serviceName])
      return {
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        status: 'SUCCESS',
        sourceSha: sha,
      }
    },
    async readHealth(request) {
      calls.push(['readHealth', request.serviceName])
      return {
        healthy: true,
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        revision: sha,
      }
    },
    ...overrides,
  }
  return { adapter, calls, deployRequests }
}

test('provider deployment binding remains absent and held', () => {
  assert.deepEqual(RAILWAY_DEPLOYMENT_PROVIDER_BINDING, {
    available: false,
    state: 'held',
    reason: 'unverified-provider-mutation-command',
  })
})

test('deploys all three exact staging services at one full SHA, waits, then reads health once per service', async () => {
  const { adapter, calls, deployRequests } = createAdapter()
  const result = await runStagingDeploy({ releaseSha: sha, adapter })

  assert.equal(result.ok, true)
  assert.equal(result.revision, sha)
  assert.deepEqual(STAGING_DEPLOY_TARGET, {
    projectId: '8621111a-4ac8-4d88-9566-4627c8a02059',
    environmentId: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  })
  assert.deepEqual(STAGING_DEPLOY_SERVICES, {
    'staging-web': '9fec9bdb-1915-4bee-8213-f6c3d434baa1',
    'staging-dashboard': 'b2f6989e-a7bc-4ad9-8ed4-a39dd67b947f',
    'staging-workers': '7c551d35-b2d4-4ab0-917f-9680ccdee86a',
  })
  assert.deepEqual(Object.keys(result.services), serviceOrder)
  assert.deepEqual(deployRequests.map((request) => [request.projectId, request.environmentId, request.serviceName, request.serviceId, request.releaseSha]), serviceOrder.map((name) => [STAGING_DEPLOY_TARGET.projectId, STAGING_DEPLOY_TARGET.environmentId, name, STAGING_DEPLOY_SERVICES[name], sha]))
  assert.deepEqual(calls.filter(([kind]) => kind === 'deploy').map(([, name, revision]) => [name, revision]), serviceOrder.map((name) => [name, sha]))
  assert.deepEqual(calls.filter(([kind]) => kind === 'readHealth').map(([, name]) => name), serviceOrder)
  assert.equal(calls.at(-3)[0], 'readHealth', 'health readbacks occur after every deployment has finished')
})

test('rejects an invalid revision before any provider call', async () => {
  const { adapter, calls } = createAdapter()
  await assert.rejects(runStagingDeploy({ releaseSha: 'a'.repeat(39), adapter }), { code: 'invalid-release-sha' })
  assert.deepEqual(calls, [])
})

test('rejects any target identity drift before the first deployment', async () => {
  const { adapter, calls } = createAdapter({
    async readTarget() {
      calls.push(['readTarget'])
      return {
        projectId: STAGING_DEPLOY_TARGET.projectId,
        environmentId: STAGING_DEPLOY_TARGET.environmentId,
        services: { ...STAGING_DEPLOY_SERVICES, 'staging-workers': 'foreign-service' },
      }
    },
  })
  await assert.rejects(runStagingDeploy({ releaseSha: sha, adapter }), { code: 'staging-target-identity-mismatch' })
  assert.equal(calls.some(([kind]) => kind === 'deploy'), false)
})

test('stops after a successful deployment reports a mixed SHA and never advances to workers', async () => {
  const { adapter, calls } = createAdapter({
    async readDeployment(request) {
      calls.push(['readDeployment', request.serviceName])
      return {
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        status: 'SUCCESS',
        sourceSha: request.serviceName === 'staging-dashboard' ? 'b'.repeat(40) : sha,
      }
    },
  })
  await assert.rejects(runStagingDeploy({ releaseSha: sha, adapter }), { code: 'deployment-revision-mismatch' })
  assert.deepEqual(calls.filter(([kind]) => kind === 'deploy').map(([, name]) => name), ['staging-web', 'staging-dashboard'])
  assert.equal(calls.some(([kind]) => kind === 'readHealth'), false)
})

test('stops on provider deployment failure without deploying later services', async () => {
  const { adapter, calls } = createAdapter({
    async readDeployment(request) {
      calls.push(['readDeployment', request.serviceName])
      return {
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        status: request.serviceName === 'staging-dashboard' ? 'FAILED' : 'SUCCESS',
        sourceSha: sha,
      }
    },
  })
  await assert.rejects(runStagingDeploy({ releaseSha: sha, adapter }), { code: 'deployment-failed' })
  assert.deepEqual(calls.filter(([kind]) => kind === 'deploy').map(([, name]) => name), ['staging-web', 'staging-dashboard'])
  assert.equal(calls.some(([kind]) => kind === 'readHealth'), false)
})

test('stops when any service health readback is unhealthy or reports another SHA', async () => {
  const { adapter, calls } = createAdapter({
    async readHealth(request) {
      calls.push(['readHealth', request.serviceName])
      return {
        healthy: request.serviceName !== 'staging-dashboard',
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        revision: request.serviceName === 'staging-workers' ? 'b'.repeat(40) : sha,
      }
    },
  })
  await assert.rejects(runStagingDeploy({ releaseSha: sha, adapter }), { code: 'health-readback-failed' })
  assert.deepEqual(calls.filter(([kind]) => kind === 'readHealth').map(([, name]) => name), ['staging-web', 'staging-dashboard'])
})



test('waits through pending states before accepting the deployment SHA', async () => {
  const { adapter, calls } = createAdapter({
    async readDeployment(request) {
      calls.push(['readDeployment', request.serviceName])
      const status = calls.filter(([kind, name]) => kind === 'readDeployment' && name === request.serviceName).length === 1
        ? 'BUILDING'
        : 'SUCCESS'
      return {
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        status,
        sourceSha: sha,
      }
    },
  })
  let waits = 0
  const result = await runStagingDeploy({
    releaseSha: sha,
    adapter,
    maxPolls: 2,
    pollIntervalMs: 0,
    sleep: async () => { waits += 1 },
  })
  assert.equal(result.ok, true)
  assert.equal(waits, 3)
  assert.equal(calls.filter(([kind]) => kind === 'readDeployment').length, 6)
})

test('times out when a deployment remains pending within the bounded wait', async () => {
  const { adapter } = createAdapter({
    async readDeployment(request) {
      return {
        projectId: request.projectId,
        environmentId: request.environmentId,
        serviceId: request.serviceId,
        deploymentId: request.deploymentId,
        status: 'DEPLOYING',
        sourceSha: sha,
      }
    },
  })
  await assert.rejects(
    runStagingDeploy({ releaseSha: sha, adapter, maxPolls: 2, pollIntervalMs: 0, sleep: async () => {} }),
    { code: 'deployment-timeout' },
  )
})

test('refuses an adapter without the explicit mock marker', async () => {
  const { adapter, calls } = createAdapter()
  adapter.kind = 'railway-cli'
  await assert.rejects(runStagingDeploy({ releaseSha: sha, adapter }), { code: 'railway-provider-binding-held' })
  assert.deepEqual(calls, [])
})
