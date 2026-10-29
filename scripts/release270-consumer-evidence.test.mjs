import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import {
  collectRelease270ConsumerObservation,
  createRelease270ConsumerReader,
  RELEASE270_CONSUMER_OBSERVATION,
} from './lib/release270-consumer-evidence.mjs'
import { assertRelease270ConsumerEvidence } from './lib/release270-readback.mjs'
import { RELEASE270_STAGING_QUEUE_RESOURCE } from './lib/release270-staging-admission.mjs'
import { seedRelease270DormantRedis } from './lib/release270-disposable-fixtures.mjs'

const releaseSha = 'a'.repeat(40),
  collectorHash = 'b'.repeat(64)
const resource = RELEASE270_STAGING_QUEUE_RESOURCE
const instant = Date.parse('2026-10-29T03:00:00.000Z')
const iso = (n = 0) => new Date(instant + n).toISOString()
// Explicitly fictional transport: proves request mechanics, not Railway holds.
function observation(request) {
  return {
    schema: RELEASE270_CONSUMER_OBSERVATION,
    challenge: request.challenge,
    requestStartedAt: request.requestStartedAt,
    releaseSha,
    resource,
    collectorHash,
    providerRevision: 'fictional-control-plane-revision',
    observedAt: request.requestStartedAt,
    completedAt: request.requestStartedAt,
    evidence: {
      schema: 'torchiko-release270-consumer-inventory/v1',
      releaseSha,
      resource,
      observedAt: request.requestStartedAt,
      coverage: 'all-staging-deployed-consumers',
      unexpectedConsumers: 0,
      consumersHeld: true,
      inventory: [
        {
          serviceId: 'fictional-worker',
          consumersHeld: true,
          workerFlags: { FICTIONAL_WORKER: 'false' },
        },
      ],
    },
  }
}
const options = (readConsumers = async (request) => observation(request), now = () => instant) => ({
  readConsumers,
  releaseSha,
  resource,
  trustedCollectorHash: collectorHash,
  now,
})

test('fresh challenges change receipts while stable inventory and worker policy stay equal', async () => {
  const first = await collectRelease270ConsumerObservation(options())
  const second = await collectRelease270ConsumerObservation(options(undefined, () => instant + 1))
  assert.notEqual(first.receipt.challenge, second.receipt.challenge)
  assert.notEqual(first.receipt.observationSha256, second.receipt.observationSha256)
  assert.equal(first.receipt.inventorySha256, second.receipt.inventorySha256)
  const check = (value) =>
    assertRelease270ConsumerEvidence(value.evidence, {
      releaseSha,
      expectedHash: value.receipt.inventorySha256,
      now: instant + 1,
    })
  assert.deepEqual(check(first), check(second))
  assert.ok(!Object.hasOwn(first.receipt, 'evidence'))
})

test('a previously valid response cannot satisfy a second challenge even with restamped times', async () => {
  let cached
  const first = await collectRelease270ConsumerObservation(
    options(async (request) => {
      cached = observation(request)
      return cached
    }),
  )
  assert.ok(first.receipt.observationSha256)
  await assert.rejects(
    collectRelease270ConsumerObservation(
      options(
        async (request) => ({
          ...cached,
          requestStartedAt: request.requestStartedAt,
          observedAt: request.requestStartedAt,
          completedAt: request.requestStartedAt,
          evidence: { ...cached.evidence, observedAt: request.requestStartedAt },
        }),
        () => instant + 1,
      ),
    ),
    /challenge-mismatch/u,
  )
})

test('missing trusted collector refuses before invoking transport; legacy timestamped file refuses', async () => {
  let invoked = false
  await assert.rejects(
    collectRelease270ConsumerObservation({
      ...options(async () => {
        invoked = true
      }),
      trustedCollectorHash: undefined,
    }),
    /trusted-collector-required/u,
  )
  assert.equal(invoked, false)
  await assert.rejects(
    collectRelease270ConsumerObservation(options(async (r) => observation(r).evidence)),
  )
})

test('stale, future, altered scope/collector, missing revision and oversized observations refuse', async () => {
  for (const change of [
    (v) => {
      v.rawProviderPayload = 'must never enter receipt journal'
    },
    (v) => {
      v.collectorHash = 'c'.repeat(64)
    },
    (v) => {
      v.releaseSha = 'c'.repeat(40)
    },
    (v) => {
      v.resource = 'fictional-other-resource'
    },
    (v) => {
      v.providerRevision = ''
    },
    (v) => {
      v.observedAt = iso(-1)
    },
    (v) => {
      v.completedAt = iso(1)
    },
    (v) => {
      v.evidence.observedAt = iso(-1)
    },
    (v) => {
      v.completedAt = '2026-10-29T03:00:00Z'
    },
    (v) => {
      v.evidence.unexpected = 'x'.repeat(1024 * 1024)
    },
  ])
    await assert.rejects(
      collectRelease270ConsumerObservation(
        options(async (r) => {
          const value = observation(r)
          change(value)
          return value
        }),
      ),
    )
  let calls = 0
  await assert.rejects(
    collectRelease270ConsumerObservation(
      options(
        async (r) => observation(r),
        () => instant + (calls++ ? 60_001 : 0),
      ),
    ),
    /observation-stale/u,
  )
})

test('reviewed reader wrapper validates responses and preserves evidence for stable policy admission', async () => {
  const reader = createRelease270ConsumerReader({
    collect: async (r) => observation(r),
    trustedCollectorHash: collectorHash,
    now: () => instant,
  })
  const value = await collectRelease270ConsumerObservation(options(reader))
  const { observedAt, ...stable } = value.evidence
  assert.equal(
    value.receipt.inventorySha256,
    createHash('sha256').update(JSON.stringify(stable)).digest('hex'),
  )
})

test('Redis fixture rejects unconfirmed, hosted or nonempty endpoints before setup writes', async () => {
  for (const connection of [
    {
      options: { host: 'fictional-hosted.example', db: 0 },
      call: async () => {
        throw Error('called')
      },
    },
    {
      options: { host: '127.0.0.1', db: 1 },
      call: async () => {
        throw Error('called')
      },
    },
    {
      options: { host: '127.0.0.1', db: 0 },
      call: async (cmd) => {
        assert.equal(cmd, 'DBSIZE')
        return 1
      },
    },
  ])
    await assert.rejects(
      seedRelease270DormantRedis(connection, { confirm: 'fictional-release270-disposable' }),
    )
  await assert.rejects(seedRelease270DormantRedis({ options: { host: '127.0.0.1' } }))
})
