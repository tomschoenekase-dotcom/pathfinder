// Challenge/receipt mechanics only. A caller must separately review and trust the
// authenticated transport. Hashes and echoed challenges do not authenticate a provider.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

export const RELEASE270_CONSUMER_REQUEST = 'torchiko-release270-consumer-request/v1'
export const RELEASE270_CONSUMER_OBSERVATION = 'torchiko-release270-consumer-observation/v1'
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hashPattern = /^[a-f0-9]{64}$/u
const time = (value) => {
  assert.equal(typeof value, 'string', 'release270-consumer-canonical-time-required')
  const parsed = Date.parse(value)
  assert.ok(Number.isFinite(parsed), 'release270-consumer-time-invalid')
  assert.equal(new Date(parsed).toISOString(), value, 'release270-consumer-canonical-time-required')
  return parsed
}

// Deliberately no file-reading or live-provider implementation: the operational
// runner remains closed until an independently reviewed transport is supplied.
export function createRelease270ConsumerReader({ collect, trustedCollectorHash, now = Date.now }) {
  assert.equal(typeof collect, 'function', 'release270-consumer-transport-required')
  assert.match(trustedCollectorHash ?? '', hashPattern, 'release270-trusted-collector-required')
  return async (request) => {
    const result = await collect(request)
    assertRelease270ConsumerObservation(result, request, { trustedCollectorHash, now: now() })
    return result
  }
}

export function assertRelease270ConsumerObservation(
  observation,
  request,
  { trustedCollectorHash, now },
) {
  assert.match(trustedCollectorHash ?? '', hashPattern, 'release270-trusted-collector-required')
  assert.equal(request?.schema, RELEASE270_CONSUMER_REQUEST)
  assert.match(request.challenge ?? '', hashPattern)
  assert.equal(observation?.schema, RELEASE270_CONSUMER_OBSERVATION)
  assert.deepEqual(
    Object.keys(observation).sort(),
    [
      'schema',
      'challenge',
      'requestStartedAt',
      'releaseSha',
      'resource',
      'collectorHash',
      'providerRevision',
      'observedAt',
      'completedAt',
      'evidence',
    ].sort(),
    'release270-consumer-observation-fields-refused',
  )
  assert.equal(observation.challenge, request.challenge, 'release270-consumer-challenge-mismatch')
  assert.equal(
    observation.requestStartedAt,
    request.requestStartedAt,
    'release270-consumer-request-mismatch',
  )
  assert.equal(observation.releaseSha, request.releaseSha, 'release270-consumer-source-mismatch')
  assert.equal(observation.resource, request.resource, 'release270-consumer-resource-mismatch')
  assert.equal(
    observation.collectorHash,
    trustedCollectorHash,
    'release270-consumer-collector-mismatch',
  )
  assert.ok(
    typeof observation.providerRevision === 'string' &&
      observation.providerRevision.length > 0 &&
      observation.providerRevision.length <= 512,
    'release270-consumer-provider-revision-required',
  )
  const started = time(request.requestStartedAt)
  const observed = time(observation.observedAt)
  const completed = time(observation.completedAt)
  assert.ok(
    started <= observed && observed <= completed && completed <= now && now - started <= 60_000,
    'release270-consumer-observation-stale',
  )
  assert.equal(
    observation.evidence?.observedAt,
    observation.observedAt,
    'release270-consumer-inventory-time-mismatch',
  )
  assert.equal(observation.evidence.releaseSha, request.releaseSha)
  assert.equal(observation.evidence.resource, request.resource)
  assert.ok(
    Buffer.byteLength(JSON.stringify(observation)) <= 1024 * 1024,
    'release270-consumer-observation-too-large',
  )
  return observation
}

export async function collectRelease270ConsumerObservation({
  readConsumers,
  releaseSha,
  resource,
  trustedCollectorHash,
  now = Date.now,
}) {
  assert.match(releaseSha ?? '', /^[a-f0-9]{40}$/u)
  assert.ok(typeof resource === 'string' && resource.length > 0)
  assert.equal(typeof readConsumers, 'function')
  // Validate trust configuration before invoking any transport.
  assert.match(trustedCollectorHash ?? '', hashPattern, 'release270-trusted-collector-required')
  const request = Object.freeze({
    schema: RELEASE270_CONSUMER_REQUEST,
    challenge: randomBytes(32).toString('hex'),
    requestStartedAt: new Date(now()).toISOString(),
    releaseSha,
    resource,
  })
  const observation = await readConsumers(request)
  assertRelease270ConsumerObservation(observation, request, { trustedCollectorHash, now: now() })
  const { evidence, ...metadata } = observation
  return {
    evidence,
    receipt: {
      ...metadata,
      observationSha256: digest(observation),
      // Stable inventory seal intentionally excludes only observation time.
      inventorySha256: digest(
        Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'observedAt')),
      ),
    },
  }
}
