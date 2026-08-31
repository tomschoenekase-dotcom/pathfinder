const FULL_GIT_SHA = /^[0-9a-f]{40}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u
const REQUIRED_SERVICES = ['staging-web', 'staging-dashboard', 'staging-workers']
const MAX_STATUS_BYTES = 1_048_576

export class StagingTopologyAdmissionError extends Error {
  constructor(code) {
    super(code)
    this.name = 'StagingTopologyAdmissionError'
    this.code = code
  }
}

function fail(code) {
  throw new StagingTopologyAdmissionError(code)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function edgeNodes(container) {
  if (!isRecord(container) || !Array.isArray(container.edges)) fail('invalid-topology-shape')
  return container.edges.map((edge) => {
    if (!isRecord(edge) || !isRecord(edge.node)) fail('invalid-topology-shape')
    return edge.node
  })
}

export function parseStagingTopologyArgs(args) {
  if (args.length !== 2 || args[0] !== '--expected-revision') fail('invalid-options')
  const expectedRevision = args[1]
  if (!FULL_GIT_SHA.test(expectedRevision)) fail('invalid-expected-revision')
  return { expectedRevision }
}

export function parseBoundedTopologyJson(text) {
  if (typeof text !== 'string') fail('invalid-topology-input')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes === 0 || bytes > MAX_STATUS_BYTES) fail('invalid-topology-input')
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid-topology-json')
  }
}

export function validateStagingTopology(payload, expectedRevision) {
  if (!FULL_GIT_SHA.test(expectedRevision)) fail('invalid-expected-revision')
  if (!isRecord(payload)) fail('invalid-topology-shape')

  const stagingEnvironments = edgeNodes(payload.environments).filter(
    (environment) => environment.name === 'staging',
  )
  if (stagingEnvironments.length !== 1) fail('staging-environment-count')

  const services = edgeNodes(stagingEnvironments[0].serviceInstances)
  const result = {}
  for (const serviceName of REQUIRED_SERVICES) {
    const matches = services.filter((service) => service.serviceName === serviceName)
    if (matches.length !== 1) fail('staging-service-count')
    const deployment = matches[0].latestDeployment
    if (!isRecord(deployment) || !isRecord(deployment.meta)) fail('invalid-deployment-shape')
    if (!UUID.test(deployment.id)) fail('invalid-deployment-identity')
    if (deployment.status !== 'SUCCESS' || deployment.deploymentStopped !== false) {
      fail('deployment-not-active')
    }
    if (deployment.meta.commitHash !== expectedRevision) fail('deployment-revision-mismatch')
    if (!IMAGE_DIGEST.test(deployment.meta.imageDigest)) fail('invalid-image-digest')
    if (!Array.isArray(deployment.instances) || deployment.instances.length === 0) {
      fail('missing-deployment-instance')
    }
    const statuses = deployment.instances.map((instance) => {
      if (!isRecord(instance) || typeof instance.status !== 'string') {
        fail('invalid-deployment-instance')
      }
      return instance.status
    })
    if (statuses.filter((status) => status === 'RUNNING').length !== 1) {
      fail('running-instance-count')
    }
    if (statuses.some((status) => status !== 'RUNNING' && status !== 'REMOVED')) {
      fail('unhealthy-deployment-instance')
    }

    result[serviceName] = {
      deploymentId: deployment.id,
      deploymentStatus: 'SUCCESS',
      instanceStatus: 'RUNNING',
      revision: expectedRevision,
      imageDigest: deployment.meta.imageDigest,
    }
  }

  return { ok: true, environment: 'staging', revision: expectedRevision, services: result }
}
