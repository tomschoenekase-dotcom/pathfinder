import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isTransientRegistryFailure,
  classifyProductionAuditResult,
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
    {
      code: 0,
      stdout: JSON.stringify({
        advisories: {},
        metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
      }),
      stderr: '',
    },
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

function report(severity, count = 1) {
  const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
  if (severity) vulnerabilities[severity] = count
  return {
    advisories: severity
      ? { 1: { module_name: 'example-package', severity, github_advisory_id: 'GHSA-example' } }
      : {},
    metadata: { vulnerabilities },
  }
}

test('normalizes pinned JSON exit status at the unchanged high severity threshold and preserves report', () => {
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical']) {
    const stdout = JSON.stringify(report(severity))
    const result = classifyProductionAuditResult({ code: 1, stdout, stderr: '' })
    assert.equal(result.code, ['high', 'critical'].includes(severity) ? 1 : 0)
    assert.equal(result.stdout, stdout)
    assert.equal(result.auditReportValid, true)
  }
  assert.equal(
    classifyProductionAuditResult({ code: 0, stdout: JSON.stringify(report()), stderr: '' }).code,
    0,
  )
})

test('unknown, inconsistent or malformed reports always fail closed, including process success', () => {
  const cases = [
    '',
    '{',
    '{}',
    JSON.stringify({ advisories: {} }),
    JSON.stringify(report('low', 2)),
    JSON.stringify({
      ...report('low'),
      advisories: { 1: { module_name: 'example', severity: 'unknown' } },
    }),
    JSON.stringify({
      ...report(),
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, novel: 1 },
      },
    }),
    JSON.stringify({ ...report(), error: 'incomplete registry response' }),
  ]
  for (const stdout of cases)
    for (const code of [0, 1])
      assert.notEqual(classifyProductionAuditResult({ code, stdout, stderr: '' }).code, 0)
  for (const result of [
    { code: 2, stdout: JSON.stringify(report('low')), stderr: '' },
    { code: 1, stdout: JSON.stringify(report('low')), stderr: '', signal: 'SIGTERM' },
    { code: 1, stdout: JSON.stringify(report('low')), stderr: '', executionError: true },
  ])
    assert.notEqual(classifyProductionAuditResult(result).code, 0)
})

test('a valid low advisory does not retry even if its free text resembles a registry outage', async () => {
  const audit = report('low')
  audit.advisories['1'].overview = 'Potential service unavailable condition'
  const result = await runProductionDependencyAudit({
    run: async () => ({ code: 1, stdout: JSON.stringify(audit), stderr: '' }),
    sleep: async () => assert.fail('A completed report must not retry'),
  })
  assert.equal(result.code, 0)
  assert.equal(result.attempts, 1)
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
