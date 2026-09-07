import assert from 'node:assert/strict'
import test from 'node:test'
import { admitStagingRelease, STAGING_RELEASE_TARGET } from './lib/staging-release-admission.mjs'

const sha = 'a'.repeat(40)
const names = ['staging-web', 'staging-dashboard', 'staging-workers']
const resources = STAGING_RELEASE_TARGET.resources
function fixture() {
  const topology = {
    id: STAGING_RELEASE_TARGET.projectId,
    environments: {
      edges: [
        {
          node: {
            id: STAGING_RELEASE_TARGET.environmentId,
            name: 'staging',
            serviceInstances: {
              edges: names.map((serviceName, index) => ({
                node: {
                  serviceName,
                  serviceId: STAGING_RELEASE_TARGET.services[serviceName],
                  latestDeployment: {
                    id: `${index + 1}`.repeat(8) + '-1111-4111-8111-111111111111',
                    status: 'SUCCESS',
                    deploymentStopped: false,
                    instances: [{ status: 'RUNNING' }],
                    meta: { commitHash: sha, imageDigest: `sha256:${'b'.repeat(64)}` },
                  },
                },
              })),
            },
          },
        },
      ],
    },
  }
  const health = {
    healthUrl: `https://${STAGING_RELEASE_TARGET.healthHost}/api/health`,
    confirmEnvironment: 'staging',
    confirmHost: STAGING_RELEASE_TARGET.healthHost,
    expectedResources: resources,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          ok: true,
          deployment: { environment: 'staging', revision: sha, resources },
          deps: { db: 'up', queue: 'up' },
        }),
        { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } },
      ),
  }
  const executeRuntimeQuery = (args) => ({
    status: 0,
    stdout:
      args.includes('--filter') || args.includes('--http')
        ? ''
        : JSON.stringify({ action: 'workers.release-identity.admitted', revision: sha }),
  })
  return { topology, expectedRevision: sha, health, executeRuntimeQuery }
}

test('composes exact topology, public health and runtime without requiring absence maturity', async () => {
  const result = await admitStagingRelease(fixture())
  assert.equal(result.ok, true)
  assert.equal(Object.keys(result.topology.services).length, 3)
  assert.equal(result.runtime.founderAbsence.retainedEvents, 0)
  assert.equal(result.migrationAuthorityGranted, false)
})

for (const index of [1, 2])
  test(`healthy web cannot admit mismatched ${names[index]}`, async () => {
    const input = fixture()
    input.topology.environments.edges[0].node.serviceInstances.edges[
      index
    ].node.latestDeployment.meta.commitHash = 'c'.repeat(40)
    let requestedHealth = false
    input.health.fetchImpl = async () => {
      requestedHealth = true
      throw new Error('not expected')
    }
    await assert.rejects(admitStagingRelease(input), /deployment-revision-mismatch/u)
    assert.equal(requestedHealth, false)
  })

test('runtime errors and missing worker identity still reject an otherwise healthy topology', async () => {
  const input = fixture()
  input.executeRuntimeQuery = () => ({ status: 0, stdout: '' })
  await assert.rejects(admitStagingRelease(input), /worker-release-identity-missing/u)
  const original = fixture().executeRuntimeQuery
  input.executeRuntimeQuery = (args) =>
    args.includes('--filter')
      ? { status: 0, stdout: JSON.stringify({ level: 'error', message: 'aborted ECONNRESET' }) }
      : original(args)
  await assert.rejects(admitStagingRelease(input), /runtime-error-rows/u)
})

for (const dimension of ['project', 'environment', 'service', 'host', 'database']) {
  test(`rejects a same-named staging topology with the wrong ${dimension} identity before network access`, async () => {
    const input = fixture()
    if (dimension === 'project') input.topology.id = 'other-project'
    if (dimension === 'environment') input.topology.environments.edges[0].node.id = 'other-environment'
    if (dimension === 'service') input.topology.environments.edges[0].node.serviceInstances.edges[0].node.serviceId = 'other-service'
    if (dimension === 'host') input.health.confirmHost = 'other.example.test'
    if (dimension === 'database') input.health.expectedResources = { ...resources, database: 'other-database' }
    input.health.fetchImpl = () => { throw new Error('must not fetch') }
    await assert.rejects(admitStagingRelease(input), /staging-target-identity-mismatch/)
  })
}
