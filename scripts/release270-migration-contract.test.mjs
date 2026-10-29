import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { assertFrozenManifest, readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import {
  assertRelease270Ledger,
  assertRelease270Manifest,
  release267Prefix,
  RELEASE270_SUFFIX,
} from './lib/release270-migration-contract.mjs'

const currentManifest = await readMigrationManifest(
  fileURLToPath(new URL('../packages/db/prisma', import.meta.url)),
)
const manifest = currentManifest
const copy = () => ({
  ...manifest,
  names: [...manifest.names],
  checksums: new Map(manifest.checksums),
})
const ledger = () =>
  manifest.names.map((name, index) => ({
    id: `fictional-ledger-${index}`,
    started_at: new Date('2026-10-22T00:00:00Z'),
    applied_steps_count: 1,
    migration_name: name,
    checksum: manifest.ledgerChecksums.get(name),
    finished_at: new Date('2026-10-23T00:00:00Z'),
    rolled_back_at: null,
    logs: '',
  }))

test('candidate270 inventory retains exact approved267 and hosted contract refuses suffix', () => {
  assert.equal(assertRelease270Manifest(manifest), manifest)
  assert.throws(() => assertFrozenManifest(manifest), /migration count changed/u)
  const historical = release267Prefix(manifest)
  assert.equal(historical.names.length, 267)
  assertFrozenManifest(historical)
})

test('267 prefix, either suffix, ordering and unknown extra migrations fail closed', () => {
  for (const name of [manifest.names[5], ...RELEASE270_SUFFIX.map((row) => row.name)]) {
    const changed = copy()
    changed.checksums.set(name, '0'.repeat(64))
    assert.throws(() => assertRelease270Manifest(changed))
  }
  const extra = copy()
  extra.names.push('20261024000000_unreviewed')
  assert.throws(() => assertRelease270Manifest(extra), /count-refused/u)
  const reordered = copy()
  reordered.names.reverse()
  assert.throws(() => assertRelease270Manifest(reordered))
  const duplicate = copy()
  duplicate.names[268] = duplicate.names[267]
  assert.throws(() => assertRelease270Manifest(duplicate), /duplicate-name/u)
  assert.throws(
    () => assertRelease270Manifest({ ...manifest, hash: '0'.repeat(64) }),
    /manifest-refused/u,
  )
})

test('read-only ledger reports exact267 and270 boundaries without hosted write permission', () => {
  const before = assertRelease270Ledger(ledger().slice(0, 267), manifest)
  assert.deepEqual(before, {
    state: 'predecessor267',
    pending: RELEASE270_SUFFIX.map((row) => row.name),
    hostedApplicationAuthorized: false,
  })
  assert.deepEqual(assertRelease270Ledger(ledger(), manifest), {
    state: 'complete270',
    pending: [],
    hostedApplicationAuthorized: false,
  })
  assert.equal(release267Prefix(manifest).names.length, 267)
})

test('read-only ledger refuses partial, failed, rolled back, wrong-byte and extra history', () => {
  assert.throws(() => assertRelease270Ledger(ledger().slice(0, 268), manifest), /boundary-refused/u)
  const extra = ledger()
  extra.push(extra.at(-1))
  assert.throws(() => assertRelease270Ledger(extra, manifest), /boundary-refused/u)
  for (const index of [10, 267, 268, 269]) {
    for (const replacement of [
      { checksum: '0'.repeat(64) },
      { finished_at: null },
      { rolled_back_at: new Date() },
      { logs: 'failure' },
      { migration_name: 'unexpected' },
    ]) {
      const rows = ledger()
      Object.assign(rows[index], replacement)
      assert.throws(() => assertRelease270Ledger(rows, manifest))
    }
  }
})

test('caller-controlled checksum maps cannot authorize divergent prefix or suffix ledgers', () => {
  for (const index of [10, 267, 268, 269]) {
    for (const mapName of ['ledgerChecksums', 'crlfLedgerChecksums']) {
      const changed = { ...copy(), [mapName]: new Map(manifest[mapName]) }
      changed[mapName].set(manifest.names[index], '0'.repeat(64))
      const rows = ledger()
      rows[index].checksum = '0'.repeat(64)
      assert.throws(() => assertRelease270Manifest(changed))
      assert.throws(() => assertRelease270Ledger(rows, changed))
    }
  }
  const crlfRows = ledger().map((row) => ({
    ...row,
    checksum: manifest.crlfLedgerChecksums.get(row.migration_name),
  }))
  assert.equal(assertRelease270Ledger(crlfRows, manifest).state, 'complete270')
})

test('all incomplete and oversized physical ledgers fail closed', () => {
  for (const count of [0, 266, 268])
    assert.throws(() => assertRelease270Ledger(ledger().slice(0, count), manifest))
  const rows = ledger()
  rows.push({ ...rows[10], rolled_back_at: '2026-10-24T00:00:00Z' })
  assert.throws(() => assertRelease270Ledger(rows, manifest), /boundary-refused/u)
})

test('explicit staging269 boundary admits exactly one pending migration', () => {
  assert.deepEqual(assertRelease270Ledger(ledger().slice(0, 269), manifest), {
    state: 'predecessor269',
    pending: [RELEASE270_SUFFIX[2].name],
    hostedApplicationAuthorized: false,
  })
})
test('ledger refuses missing, duplicate, invalid steps and unordered lifecycle evidence', () => {
  for (const change of [
    { applied_steps_count: undefined },
    { applied_steps_count: 0 },
    { applied_steps_count: 2 },
    { started_at: 'invalid' },
    { started_at: '2030-01-01' },
    { id: '' },
    { logs: undefined },
  ]) {
    const rows = ledger()
    Object.assign(rows[267], change)
    assert.throws(() => assertRelease270Ledger(rows, manifest))
  }
  const rows = ledger()
  rows[1].id = rows[0].id
  assert.throws(() => assertRelease270Ledger(rows, manifest), /id-duplicate/u)
})
test('known historical zero-step rows require exact explicit reconciliation', () => {
  const rows = ledger()
  const row = rows.find((r) => r.migration_name === '007_venue_branding')
  row.applied_steps_count = 0
  assert.throws(() => assertRelease270Ledger(rows, manifest), /zero-step-reconciliation/u)
  const reconciledZeroStepRows = [
    {
      id: row.id,
      migration_name: row.migration_name,
      checksum: row.checksum,
      started_at: row.started_at.toISOString(),
      finished_at: row.finished_at.toISOString(),
    },
  ]
  assert.equal(
    assertRelease270Ledger(rows, manifest, { reconciledZeroStepRows }).state,
    'complete270',
  )
  reconciledZeroStepRows[0].id = 'wrong'
  assert.throws(() => assertRelease270Ledger(rows, manifest, { reconciledZeroStepRows }))
})
