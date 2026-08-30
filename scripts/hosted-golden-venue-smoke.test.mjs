import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assessSyntheticAnswer,
  parseHostedGoldenVenueArgs,
  resolveHostedGoldenVenueReportPath,
  validateHostedHealth,
} from '../apps/dashboard/scripts/hosted-golden-venue-smoke.mjs'

const revision = 'a'.repeat(40)
const policy = {
  resources: { database: 'db-staging', redis: 'redis-staging', storage: 'storage-staging' },
}
const health = {
  ok: true,
  deployment: {
    environment: 'staging',
    revision,
    resources: policy.resources,
  },
  deps: { db: 'up', queue: 'up' },
}

test('hosted Golden Venue smoke requires one exact immutable revision', () => {
  assert.deepEqual(parseHostedGoldenVenueArgs(['--revision', revision]), {
    revision,
    questionKey: null,
    report: null,
  })
  assert.throws(() => parseHostedGoldenVenueArgs([]), /exact-revision-required/u)
  assert.throws(
    () => parseHostedGoldenVenueArgs(['--revision', 'main']),
    /exact-revision-required/u,
  )
  assert.throws(
    () => parseHostedGoldenVenueArgs(['--revision', revision, '--origin', 'https://example.com']),
    /unknown-option/u,
  )
})

test('hosted health must match staging, revision, dependencies, and reviewed resource identities', () => {
  assert.doesNotThrow(() => validateHostedHealth(health, policy, revision))
  assert.throws(
    () =>
      validateHostedHealth(
        { ...health, deployment: { ...health.deployment, revision: 'b'.repeat(40) } },
        policy,
        revision,
      ),
    /exact-staging-health-rejected/u,
  )
  assert.throws(
    () =>
      validateHostedHealth(
        {
          ...health,
          deployment: {
            ...health.deployment,
            resources: { ...health.deployment.resources, storage: 'wrong' },
          },
        },
        policy,
        revision,
      ),
    /staging-storage-identity-mismatch/u,
  )
})

test('provider evidence is content-addressed and checks every synthetic expected fact', () => {
  const passed = assessSyntheticAnswer('The feeding begins at 3:00 PM beside the Shark Tank.', [
    '3:00 PM',
    'Shark Tank',
  ])
  assert.equal(passed.passed, true)
  assert.match(passed.sha256, /^[a-f0-9]{64}$/u)
  assert.equal(passed.utf8Bytes > 0, true)
  assert.equal(assessSyntheticAnswer('Try again later.', ['Shark Tank']).passed, false)
})

test('hosted reports remain JSON files inside the repository', () => {
  assert.match(
    resolveHostedGoldenVenueReportPath(null, revision),
    /artifacts[\\/]hosted-golden-venue[\\/][a-f0-9]{40}\.json$/u,
  )
  assert.throws(
    () => resolveHostedGoldenVenueReportPath('../outside.json', revision),
    /unsafe-report-path/u,
  )
  assert.throws(
    () => resolveHostedGoldenVenueReportPath('artifacts/report.txt', revision),
    /report-must-be-json/u,
  )
})
