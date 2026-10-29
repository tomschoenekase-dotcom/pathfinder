// Candidate inventory/read-only ledger admission only. This does not authorize or run hosted SQL.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EXPECTED, assertFrozenManifest, ledgerState } from '../run-staging-migration-predeploy.mjs'

export const RELEASE270 = Object.freeze({
  migrationCount: 270,
  manifestHash: '5f7bff510f416e55b32fd69ab700675a814f3eb3e926528c52fd0e404b1b6de1',
  crlfManifestHash: '5a4929f3b1d894abeef0aab1228db4e714b37fd0ab005061e58e55b6cea7c282',
  predecessorCount: 267,
  predecessorManifestHash: EXPECTED.manifestHash,
  publicTableCount: 299,
  hostedApplicationAuthorized: false,
})
export const RELEASE270_SUFFIX = Object.freeze([
  Object.freeze({
    name: '20261022001000_deterministic_event_search_projection',
    checksum: '2089bc647ea8982fbebd2d874c60aa3fa014050a3d5bbddd7147fd632e1f6cf4',
  }),
  Object.freeze({
    name: '20261023001000_add_fact_applicability',
    checksum: 'ff62453a47c7d64e1c30706935755a8f27b0694517b3bde07627c2bbd5cba664',
  }),
  Object.freeze({
    name: '20261029120000_venue_embedding_refresh',
    checksum: '91a74a3d9ab7839d284ca16ea55a1fe20107b4c8155d0fe85c102a875cbe6b80',
  }),
])
const hashRows = (names, checksums) =>
  createHash('sha256')
    .update(`${names.map((name) => `${name} ${checksums.get(name)}`).join('\n')}\n`)
    .digest('hex')

export function release267Prefix(manifest) {
  const names = manifest.names.slice(0, RELEASE270.predecessorCount)
  const subset = (map) => new Map(names.map((name) => [name, map?.get(name)]))
  const prefix = {
    names,
    checksums: subset(manifest.checksums),
    ledgerChecksums: subset(manifest.ledgerChecksums),
    crlfLedgerChecksums: subset(manifest.crlfLedgerChecksums),
    hash: hashRows(names, manifest.checksums),
  }
  assertFrozenManifest(prefix)
  return prefix
}

export function assertRelease270Manifest(manifest) {
  assert.equal(manifest.names.length, RELEASE270.migrationCount, 'release270-count-refused')
  assert.equal(new Set(manifest.names).size, RELEASE270.migrationCount, 'release270-duplicate-name')
  release267Prefix(manifest)
  for (const [index, row] of RELEASE270_SUFFIX.entries()) {
    assert.equal(manifest.names[267 + index], row.name, 'release270-suffix-name-refused')
    assert.equal(manifest.checksums.get(row.name), row.checksum, 'release270-suffix-bytes-refused')
  }
  assert.equal(hashRows(manifest.names, manifest.checksums), RELEASE270.manifestHash)
  assert.equal(manifest.hash, RELEASE270.manifestHash, 'release270-manifest-refused')
  // The caller cannot forge a raw-byte checksum map to admit a divergent ledger.
  // Pin the entire canonical CRLF map as well as the LF map above.
  assert.equal(
    hashRows(manifest.names, manifest.crlfLedgerChecksums),
    RELEASE270.crlfManifestHash,
    'release270-crlf-manifest-refused',
  )
  for (const name of manifest.names) {
    assert.ok(
      [manifest.checksums.get(name), manifest.crlfLedgerChecksums.get(name)].includes(
        manifest.ledgerChecksums?.get(name),
      ),
      'release270-raw-checksum-refused',
    )
  }
  return manifest
}

// Supply the complete physical ledger. Rolled-back, failed and extra physical rows
// are refused, never filtered. Historical reconciliation needs a separate reviewed contract.
export function assertRelease270Ledger(rows, manifest, { reconciledZeroStepRows = [] } = {}) {
  assertRelease270Manifest(manifest)
  assert.ok(Array.isArray(rows), 'release270-ledger-required')
  assert.ok([267, 269, 270].includes(rows.length), 'release270-ledger-boundary-refused')
  assert.ok(Array.isArray(reconciledZeroStepRows), 'release270-zero-step-proof-required')
  const zeroStepRows = []
  const ids = new Set()
  for (const row of rows) {
    assert.equal(typeof row.id, 'string', 'release270-ledger-id-required')
    assert.ok(row.id.length > 0 && !ids.has(row.id), 'release270-ledger-id-duplicate')
    ids.add(row.id)
    assert.ok(
      row.started_at instanceof Date || typeof row.started_at === 'string',
      'release270-ledger-start-required',
    )
    assert.ok(
      Number.isFinite(new Date(row.started_at).valueOf()),
      'release270-ledger-start-invalid',
    )
    assert.ok([0, 1].includes(row.applied_steps_count), 'release270-ledger-step-count')
    if (row.applied_steps_count === 0) {
      assert.ok(
        [
          '20260502000000_add_venue_guide_mode',
          '20260502001000_optional_coords_and_item_type',
          '007_venue_branding',
        ].includes(row.migration_name),
        'release270-unknown-zero-step',
      )
      zeroStepRows.push({
        id: row.id,
        migration_name: row.migration_name,
        checksum: row.checksum,
        started_at: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
        finished_at:
          row.finished_at instanceof Date ? row.finished_at.toISOString() : row.finished_at,
      })
    }
    assert.ok(row && typeof row.migration_name === 'string', 'release270-ledger-row-required')
    assert.match(row.checksum ?? '', /^[a-f0-9]{64}$/u, 'release270-ledger-checksum-required')
    assert.ok(
      row.finished_at instanceof Date || typeof row.finished_at === 'string',
      'release270-ledger-unfinished',
    )
    assert.ok(
      Number.isFinite(new Date(row.finished_at).valueOf()),
      'release270-ledger-invalid-time',
    )
    assert.ok(new Date(row.started_at) <= new Date(row.finished_at), 'release270-ledger-time-order')
    assert.equal(row.rolled_back_at, null, 'release270-ledger-rolled-back')
    assert.ok(row.logs === null || row.logs === '', 'release270-ledger-error-logs')
  }
  assert.deepEqual(zeroStepRows, reconciledZeroStepRows, 'release270-zero-step-reconciliation')
  const prefix = release267Prefix(manifest)
  assert.equal(ledgerState(rows.slice(0, 267), prefix), 'complete')
  for (let index = 267; index < rows.length; index += 1) {
    const row = rows[index]
    const expected = RELEASE270_SUFFIX[index - 267]
    assert.equal(row.migration_name, expected.name, 'release270-ledger-name-refused')
    assert.ok(
      [expected.checksum, manifest.crlfLedgerChecksums.get(expected.name)]
        .filter(Boolean)
        .includes(row.checksum),
      'release270-ledger-checksum-refused',
    )
  }
  return {
    state:
      rows.length === 267
        ? 'predecessor267'
        : rows.length === 269
          ? 'predecessor269'
          : 'complete270',
    pending: RELEASE270_SUFFIX.slice(rows.length - 267).map((row) => row.name),
    hostedApplicationAuthorized: false,
  }
}
