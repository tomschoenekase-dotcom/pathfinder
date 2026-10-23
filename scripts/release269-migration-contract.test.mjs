import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertFrozenManifest, readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import {
  assertRelease269Ledger,
  assertRelease269Manifest,
  release267Prefix,
  RELEASE269_SUFFIX,
} from './lib/release269-migration-contract.mjs'
import { historicalStagingFixture } from './test-support/historical-staging-manifest.mjs'

const manifest = await readMigrationManifest(
  fileURLToPath(new URL('../packages/db/prisma', import.meta.url)),
)
const copy = () => ({
  ...manifest,
  names: [...manifest.names],
  checksums: new Map(manifest.checksums),
})
const ledger = () =>
  manifest.names.map((name) => ({
    migration_name: name,
    checksum: manifest.ledgerChecksums.get(name),
    finished_at: new Date('2026-10-23T00:00:00Z'),
    rolled_back_at: null,
    logs: '',
  }))

test('candidate269 inventory retains exact approved267 and hosted contract refuses suffix', () => {
  assert.equal(assertRelease269Manifest(manifest), manifest)
  assert.throws(() => assertFrozenManifest(manifest), /migration count changed/u)
  const historical = historicalStagingFixture(manifest)
  assert.equal(historical.names.length, 267)
  assertFrozenManifest(historical)
})

test('267 prefix, either suffix, ordering and unknown extra migrations fail closed', () => {
  for (const name of [manifest.names[5], ...RELEASE269_SUFFIX.map((row) => row.name)]) {
    const changed = copy()
    changed.checksums.set(name, '0'.repeat(64))
    assert.throws(() => assertRelease269Manifest(changed))
    assert.throws(() => historicalStagingFixture(changed))
  }
  const extra = copy()
  extra.names.push('20261024000000_unreviewed')
  assert.throws(() => assertRelease269Manifest(extra), /count-refused/u)
  const reordered = copy()
  reordered.names.reverse()
  assert.throws(() => assertRelease269Manifest(reordered))
  const duplicate = copy()
  duplicate.names[268] = duplicate.names[267]
  assert.throws(() => assertRelease269Manifest(duplicate), /duplicate-name/u)
  assert.throws(
    () => assertRelease269Manifest({ ...manifest, hash: '0'.repeat(64) }),
    /manifest-refused/u,
  )
})

test('read-only ledger reports exact267 and269 boundaries without hosted write permission', () => {
  const before = assertRelease269Ledger(ledger().slice(0, 267), manifest)
  assert.deepEqual(before, {
    state: 'predecessor267',
    pending: RELEASE269_SUFFIX.map((row) => row.name),
    hostedApplicationAuthorized: false,
  })
  assert.deepEqual(assertRelease269Ledger(ledger(), manifest), {
    state: 'complete269',
    pending: [],
    hostedApplicationAuthorized: false,
  })
  assert.equal(release267Prefix(manifest).names.length, 267)
})

test('read-only ledger refuses partial, failed, rolled back, wrong-byte and extra history', () => {
  assert.throws(() => assertRelease269Ledger(ledger().slice(0, 268), manifest), /boundary-refused/u)
  const extra = ledger()
  extra.push(extra.at(-1))
  assert.throws(() => assertRelease269Ledger(extra, manifest), /boundary-refused/u)
  for (const index of [10, 267, 268]) {
    for (const replacement of [
      { checksum: '0'.repeat(64) },
      { finished_at: null },
      { rolled_back_at: new Date() },
      { logs: 'failure' },
      { migration_name: 'unexpected' },
    ]) {
      const rows = ledger()
      Object.assign(rows[index], replacement)
      assert.throws(() => assertRelease269Ledger(rows, manifest))
    }
  }
})

test('caller-controlled checksum maps cannot authorize divergent prefix or suffix ledgers', () => {
  for (const index of [10, 267, 268]) {
    for (const mapName of ['ledgerChecksums', 'crlfLedgerChecksums']) {
      const changed = { ...copy(), [mapName]: new Map(manifest[mapName]) }
      changed[mapName].set(manifest.names[index], '0'.repeat(64))
      const rows = ledger()
      rows[index].checksum = '0'.repeat(64)
      assert.throws(() => assertRelease269Manifest(changed))
      assert.throws(() => assertRelease269Ledger(rows, changed))
    }
  }
  const crlfRows = ledger().map((row) => ({
    ...row,
    checksum: manifest.crlfLedgerChecksums.get(row.migration_name),
  }))
  assert.equal(assertRelease269Ledger(crlfRows, manifest).state, 'complete269')
})
