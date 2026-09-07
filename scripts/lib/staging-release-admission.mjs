import { validateStagingTopology } from './staging-topology-admission.mjs'
import { verifyStagingHealth } from './staging-health-admission.mjs'
import { auditStagingRuntime } from './staging-runtime-audit.mjs'

export const STAGING_RELEASE_TARGET = Object.freeze({
  projectId: '8621111a-4ac8-4d88-9566-4627c8a02059',
  environmentId: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  healthHost: 'staging-web-staging-bbeb.up.railway.app',
  resources: Object.freeze({
    database: '7bd81064-588f-48a5-b138-1fc86691a09b',
    redis: 'd53ab235-d403-4d7d-b525-3ace0ef07b92',
    storage: '0a9b3c58-0c9e-47de-96ae-38df297996e8',
  }),
  services: Object.freeze({
    'staging-web': '9fec9bdb-1915-4bee-8213-f6c3d434baa1',
    'staging-dashboard': 'b2f6989e-a7bc-4ad9-8ed4-a39dd67b947f',
    'staging-workers': '7c551d35-b2d4-4ab0-917f-9680ccdee86a',
  }),
})

function assertExactTarget(topology, health) {
  const fail = () => { throw Object.assign(new Error('staging-target-identity-mismatch'), { code: 'staging-target-identity-mismatch' }) }
  if (topology?.id !== STAGING_RELEASE_TARGET.projectId) fail()
  if (health?.confirmHost !== STAGING_RELEASE_TARGET.healthHost || health?.confirmEnvironment !== 'staging') fail()
  for (const [resource, id] of Object.entries(STAGING_RELEASE_TARGET.resources)) {
    if (health?.expectedResources?.[resource] !== id) fail()
  }
  const staging = topology?.environments?.edges?.filter((edge) => edge?.node?.name === 'staging')
  if (!Array.isArray(staging) || staging.length !== 1 || staging[0].node.id !== STAGING_RELEASE_TARGET.environmentId) fail()
  const instances = staging[0].node.serviceInstances?.edges
  if (!Array.isArray(instances)) fail()
  for (const [name, id] of Object.entries(STAGING_RELEASE_TARGET.services)) {
    const matches = instances.filter((edge) => edge?.node?.serviceName === name)
    if (matches.length !== 1 || matches[0].node.serviceId !== id) fail()
  }
}

/** Read-only admission of one release across all three applications. No migration authority. */
export async function admitStagingRelease({
  topology,
  expectedRevision,
  health,
  executeRuntimeQuery,
}) {
  assertExactTarget(topology, health)
  const services = validateStagingTopology(topology, expectedRevision)
  const web = await verifyStagingHealth({ ...health, expectedRevision })
  const deployments = Object.fromEntries(
    Object.entries(services.services).map(([name, service]) => [name, service.deploymentId]),
  )
  const runtime = auditStagingRuntime(
    { deployments, expectedRevision, since: '24h', requireFounderAbsence: false },
    executeRuntimeQuery,
  )
  return {
    ok: true,
    evidenceVersion: 1,
    environment: 'staging',
    target: STAGING_RELEASE_TARGET,
    revision: expectedRevision,
    admittedAt: new Date().toISOString(),
    topology: services,
    health: web,
    runtime,
    scope: 'three-service-release',
    migrationAuthorityGranted: false,
    founderAbsenceMaturityRequired: false,
  }
}
