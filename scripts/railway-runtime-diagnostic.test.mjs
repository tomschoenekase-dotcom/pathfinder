import assert from 'node:assert/strict'
import test from 'node:test'
import { railwayRuntimeDiagnostic } from './lib/railway-runtime-diagnostic.mjs'

test('Railway JSON errors on stdout are classified without exposing their private message', () => {
  const result = railwayRuntimeDiagnostic({ stdout: JSON.stringify({ error: 'Not Authorized: private-provider-details', code: 'ERROR' }), stderr: '' })
  assert.equal(result, 'unauthorized')
  assert.ok(!result.includes('private-provider-details'))
})
test('permission and missing-resource errors remain distinct', () => {
  assert.equal(railwayRuntimeDiagnostic({ stdout: '{"error":"Insufficient scope: private-details"}' }), 'access-denied')
  assert.equal(railwayRuntimeDiagnostic({ stdout: '{"error":"No deployments found"}' }), 'resource-not-found')
})
test('human-mode stderr still identifies launch failures', () => {
  assert.equal(railwayRuntimeDiagnostic({ stderr: 'Cannot find module private-path' }), 'cli-launch-failed')
})
test('unknown or malformed output is never forwarded', () => {
  for (const stdout of ['private-provider-details', '{"error":"private-provider-details"}', '{malformed']) {
    assert.equal(railwayRuntimeDiagnostic({ stdout }), 'runtime-query-failed')
  }
})
