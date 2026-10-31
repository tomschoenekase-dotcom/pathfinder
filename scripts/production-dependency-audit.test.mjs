import assert from 'node:assert/strict'
import test from 'node:test'

import {
  evaluateProductionAudit,
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

const report = (counts, advisories = {}) =>
  JSON.stringify({
    advisories,
    metadata: {
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts },
    },
  })
const advisory = (severity, name = 'fictional-pkg') => ({
  github_advisory_id: `GHSA-${severity}`,
  module_name: name,
  severity,
  title: `${severity} issue`,
})

test('passes a clean report and a pnpm json exit caused only by moderate advisories', () => {
  assert.deepEqual(evaluateProductionAudit({ code: 0, stdout: report({}) }), {
    ok: true,
    reason: 'clean',
    advisories: [],
  })
  const moderate = evaluateProductionAudit({
    code: 1,
    stdout: report({ moderate: 2 }, { 1: advisory('moderate'), 2: advisory('moderate', 'b') }),
  })
  assert.equal(moderate.ok, true)
  assert.equal(moderate.reason, 'below-threshold-advisories')
  assert.equal(moderate.advisories.length, 2)
})

test('blocks high or critical advisories from either the counts or the advisory list', () => {
  for (const severity of ['high', 'critical']) {
    const verdict = evaluateProductionAudit({
      code: 1,
      stdout: report({ [severity]: 1 }, { 1: advisory(severity) }),
    })
    assert.deepEqual([verdict.ok, verdict.reason], [false, 'blocking-advisories'])
  }
  const listOnly = evaluateProductionAudit({
    code: 1,
    stdout: report({ moderate: 1 }, { 1: advisory('high') }),
  })
  assert.deepEqual([listOnly.ok, listOnly.reason], [false, 'blocking-advisories'])
})

test('fails closed on missing, malformed, inconsistent or unexplained audit output', () => {
  const cases = [
    [{ code: 1, stdout: '' }, 'unparseable-audit-report'],
    [{ code: 0, stdout: 'not json' }, 'unparseable-audit-report'],
    [{ code: 1, stdout: '{"error":"Service Unavailable"}' }, 'incomplete-audit-report'],
    [{ code: 0, stdout: '{"advisories":{}}' }, 'incomplete-audit-report'],
    [{ code: 0, stdout: '{"metadata":{"vulnerabilities":{}}}' }, 'incomplete-audit-report'],
    [{ code: 0, stdout: report({ high: 'one' }) }, 'invalid-severity-count'],
    [{ code: 0, stdout: report({ severe: 1 }) }, 'unknown-severity-count'],
    [{ code: 1, stdout: report({}, { 1: advisory('urgent') }) }, 'unknown-advisory-severity'],
    [{ code: 1, stdout: report({}) }, 'audit-command-failed'],
    [{ code: 1, stdout: report({ moderate: 1 }) }, 'advisory-count-mismatch'],
  ]
  for (const [result, reason] of cases) {
    const verdict = evaluateProductionAudit(result)
    assert.equal(verdict.ok, false, reason)
    assert.equal(verdict.reason, reason)
  }
})
