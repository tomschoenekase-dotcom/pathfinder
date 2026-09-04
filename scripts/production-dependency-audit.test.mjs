import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTransientRegistryFailure,
  runProductionDependencyAudit,
} from './lib/production-dependency-audit.mjs'

test('recognizes transient registry failures without misclassifying advisories', () => {
  assert.equal(
    isTransientRegistryFailure({ code: 1, stdout: '{"error":"Service Unavailable"}' }),
    true,
  )
  assert.equal(
    isTransientRegistryFailure({ code: 1, stderr: 'ERR_PNPM_META_FETCH_FAIL ETIMEDOUT' }),
    true,
  )
  assert.equal(
    isTransientRegistryFailure({ code: 1, stderr: 'dependency registry request timeout' }),
    true,
  )
  assert.equal(
    isTransientRegistryFailure({
      code: 1,
      stdout: '{"metadata":{"vulnerabilities":{"high":1}},"advisories":{"1":{}}}',
    }),
    false,
  )
})

test('retries transient failures and returns the first completed audit', async () => {
  const results = [
    { code: 1, stdout: '{"error":"503 Service Unavailable"}', stderr: '' },
    { code: 1, stdout: '', stderr: 'socket timeout' },
    { code: 0, stdout: '{"advisories":{}}', stderr: '' },
  ]
  const delays = []
  const result = await runProductionDependencyAudit({
    run: async () => results.shift(),
    sleep: async (delay) => delays.push(delay),
    delaysMs: [1, 2, 3],
  })
  assert.equal(result.code, 0)
  assert.equal(result.attempts, 3)
  assert.deepEqual(delays, [1, 2])
})

test('does not retry a real advisory failure', async () => {
  let attempts = 0
  const result = await runProductionDependencyAudit({
    run: async () => {
      attempts += 1
      return { code: 1, stdout: '{"metadata":{"vulnerabilities":{"high":1}}}', stderr: '' }
    },
    sleep: async () => assert.fail('sleep must not run'),
  })
  assert.equal(result.code, 1)
  assert.equal(result.attempts, 1)
  assert.equal(attempts, 1)
})
