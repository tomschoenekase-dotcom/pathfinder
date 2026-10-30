// Candidate inventory/read-only ledger admission only. This does not authorize or run hosted SQL.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EXPECTED, assertFrozenManifest, ledgerState } from '../run-staging-migration-predeploy.mjs'

export const RELEASE269 = Object.freeze({
  migrationCount: 269,
  manifestHash: 'f2c54b4fda515d68a9f8e45227aac3b26c0b978f5a5505827a71b853fefc67f1',
  crlfManifestHash: '4076e21c8e78c4617cae1b6595aceec8d519a00109cf5fa6f75ee447f363b6c3',
  predecessorCount: 267,
  predecessorManifestHash: EXPECTED.manifestHash,
  publicTableCount: 297,
  hostedApplicationAuthorized: false,
})
export const RELEASE269_SUFFIX = Object.freeze([
  Object.freeze({
    name: '20261022001000_deterministic_event_search_projection',
    checksum: '2089bc647ea8982fbebd2d874c60aa3fa014050a3d5bbddd7147fd632e1f6cf4',
  }),
  Object.freeze({
    name: '20261023001000_add_fact_applicability',
    checksum: 'ff62453a47c7d64e1c30706935755a8f27b0694517b3bde07627c2bbd5cba664',
  }),
])
const hashRows = (names, checksums) =>
  createHash('sha256')
    .update(`${names.map((name) => `${name} ${checksums.get(name)}`).join('\n')}\n`)
    .digest('hex')

export function release267Prefix(manifest) {
  const names = manifest.names.slice(0, RELEASE269.predecessorCount)
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

export function assertRelease269Manifest(manifest) {
  assert.equal(manifest.names.length, RELEASE269.migrationCount, 'release269-count-refused')
  assert.equal(new Set(manifest.names).size, RELEASE269.migrationCount, 'release269-duplicate-name')
  release267Prefix(manifest)
  for (const [index, row] of RELEASE269_SUFFIX.entries()) {
    assert.equal(manifest.names[267 + index], row.name, 'release269-suffix-name-refused')
    assert.equal(manifest.checksums.get(row.name), row.checksum, 'release269-suffix-bytes-refused')
  }
  assert.equal(hashRows(manifest.names, manifest.checksums), RELEASE269.manifestHash)
  assert.equal(manifest.hash, RELEASE269.manifestHash, 'release269-manifest-refused')
  // The caller cannot forge a raw-byte checksum map to admit a divergent ledger.
  // Pin the entire canonical CRLF map as well as the LF map above.
  assert.equal(
    hashRows(manifest.names, manifest.crlfLedgerChecksums),
    RELEASE269.crlfManifestHash,
    'release269-crlf-manifest-refused',
  )
  for (const name of manifest.names) {
    assert.ok(
      [manifest.checksums.get(name), manifest.crlfLedgerChecksums.get(name)].includes(
        manifest.ledgerChecksums?.get(name),
      ),
      'release269-raw-checksum-refused',
    )
  }
  return manifest
}

// Callers must supply the complete ordered active ledger; physical rolled-back rows
// require independent reconciliation and are never silently filtered here.
export function assertRelease269Ledger(rows, manifest) {
  assertRelease269Manifest(manifest)
  assert.ok(Array.isArray(rows), 'release269-ledger-required')
  assert.ok([267, 269].includes(rows.length), 'release269-ledger-boundary-refused')
  for (const row of rows) {
    assert.ok(row && typeof row.migration_name === 'string', 'release269-ledger-row-required')
    assert.match(row.checksum ?? '', /^[a-f0-9]{64}$/u, 'release269-ledger-checksum-required')
    assert.ok(
      row.finished_at instanceof Date || typeof row.finished_at === 'string',
      'release269-ledger-unfinished',
    )
    assert.ok(
      Number.isFinite(new Date(row.finished_at).valueOf()),
      'release269-ledger-invalid-time',
    )
    assert.equal(row.rolled_back_at, null, 'release269-ledger-rolled-back')
    assert.ok(row.logs === null || row.logs === '', 'release269-ledger-error-logs')
  }
  const prefix = release267Prefix(manifest)
  assert.equal(ledgerState(rows.slice(0, 267), prefix), 'complete')
  for (let index = 267; index < rows.length; index += 1) {
    const row = rows[index]
    const expected = RELEASE269_SUFFIX[index - 267]
    assert.equal(row.migration_name, expected.name, 'release269-ledger-name-refused')
    assert.ok(
      [expected.checksum, manifest.crlfLedgerChecksums.get(expected.name)]
        .filter(Boolean)
        .includes(row.checksum),
      'release269-ledger-checksum-refused',
    )
  }
  return {
    state: rows.length === 267 ? 'predecessor267' : 'complete269',
    pending: RELEASE269_SUFFIX.slice(rows.length - 267).map((row) => row.name),
    hostedApplicationAuthorized: false,
  }
}
