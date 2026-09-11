import assert from 'node:assert/strict'
import test from 'node:test'
import { parseArgs, assertOwnedPath, assertPreserved, assertSuccessfulResult, assertManifest } from './lib/migration-236-247-rehearsal.mjs'

test('requires exact candidate, explicit native root and dedicated port', () => {
  const args = ['--candidate', 'a'.repeat(40), '--native-root', process.cwd(), '--port', '55507']
  assert.equal(parseArgs(args).port, '55507')
  for (const invalid of [[], args.slice(0, -2), [...args, '--database', 'production'], [...args, '--port', '55508']]) assert.throws(() => parseArgs(invalid))
  assert.throws(() => parseArgs(args.map(value => value === '55507' ? '5432' : value)))
  assert.throws(() => parseArgs(args.map(value => value === 'a'.repeat(40) ? 'main' : value)))
})
test('owned paths reject root and traversal', () => {
  assertOwnedPath(process.cwd(), `${process.cwd()}/proof/data`)
  assert.throws(() => assertOwnedPath(process.cwd(), process.cwd()))
  assert.throws(() => assertOwnedPath(process.cwd(), `${process.cwd()}/../other`))
})
test('preservation detects same-count content and timestamp corruption while allowing new columns', () => {
  const before = { evidence: [{ id: 'one', body: 'retained', created_at: '2026-09-01' }], empty: [] }
  assert.equal(assertPreserved(before, { evidence: [{ ...before.evidence[0], added: 0 }], empty: [] })[0].countBefore, 1)
  for (const field of ['body', 'created_at']) assert.throws(() => assertPreserved(before, { evidence: [{ ...before.evidence[0], [field]: 'changed' }], empty: [] }))
  assert.throws(() => assertPreserved(before, { evidence: [], empty: [] }))
  assert.throws(() => assertPreserved(before, { evidence: before.evidence, empty: [{ id: 'unexpected' }] }))
})
test('missing restoration, failed fixture preservation or candidate drift cannot yield admission', () => {
  const result = { cases: Object.fromEntries(['uninterrupted', 'critical', 'contradiction', 'corrected', 'restore'].map(name => [name, { passed: true }])), sourceHashesStable: true, stopped: true, failedFixturePreserved: true, candidate: 'a', migrationCandidate: 'a' }
  result.cases.critical.deploy = { waiting: [{}] }
  result.cases.critical.concurrency = { records: [{}, {}] }
  Object.assign(result, { migrationFilesystemHashesStable: true, executedSnapshotHashesStable: true, portReleased: true })
  assert.doesNotThrow(() => assertSuccessfulResult(result))
  // A late failure can occur after every positive observation was collected.
  // It must not be masked by the finally block that emits the receipt.
  assert.throws(() => assertSuccessfulResult({ ...result, error: { message: 'final source verification failed' } }), /terminal error/)
  assert.throws(() => assertSuccessfulResult({ ...result, admissionFailure: 'prior terminal admission failure' }), /recorded admission failure/)
  for (const field of ['sourceHashesStable', 'migrationFilesystemHashesStable', 'executedSnapshotHashesStable', 'portReleased', 'stopped', 'failedFixturePreserved']) assert.throws(() => assertSuccessfulResult({ ...result, [field]: false }))
  assert.throws(() => assertSuccessfulResult({ ...result, cases: { ...result.cases, restore: null } }))
  assert.throws(() => assertSuccessfulResult({ ...result, migrationCandidate: 'b' }))
  assert.throws(() => assertManifest([]))
})
