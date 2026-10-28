import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EXPECTED, assertFrozenManifest } from '../run-staging-migration-predeploy.mjs'
import { RELEASE269, assertRelease269Manifest } from '../lib/release269-migration-contract.mjs'

// This is a test fixture for the previously approved staging endpoint, not a
// deployment admission. Production must still reject the pending local suffix.
export const PENDING_LOCAL_EVENT = {
  name: '20261022001000_deterministic_event_search_projection',
  checksum: '2089bc647ea8982fbebd2d874c60aa3fa014050a3d5bbddd7147fd632e1f6cf4',
}
export function historicalStagingFixture(current) {
  assertRelease269Manifest(current)
  assert.equal(current.names[EXPECTED.migrationCount], PENDING_LOCAL_EVENT.name)
  assert.equal(current.checksums.get(PENDING_LOCAL_EVENT.name), PENDING_LOCAL_EVENT.checksum)
  const names = current.names.slice(0, EXPECTED.migrationCount)
  const subset = (map) => new Map(names.map((name) => [name, map.get(name)]))
  const historical = {
    names,
    checksums: subset(current.checksums),
    ledgerChecksums: subset(current.ledgerChecksums),
    crlfLedgerChecksums: subset(current.crlfLedgerChecksums),
    hash: createHash('sha256')
      .update(`${names.map((name) => `${name} ${current.checksums.get(name)}`).join('\n')}\n`)
      .digest('hex'),
  }
  assertFrozenManifest(historical)
  for (const name of names) {
    const normalized = historical.checksums.get(name)
    const crlf = historical.crlfLedgerChecksums.get(name)
    assert.match(normalized, /^[a-f0-9]{64}$/u)
    assert.match(crlf, /^[a-f0-9]{64}$/u)
    assert.ok([normalized, crlf].includes(historical.ledgerChecksums.get(name)))
  }
  return historical
}

// Explicit test-only projection of the historical 269 inventory. The complete
// current manifest is never admitted by the old production contract.
export function historicalRelease269Fixture(current) {
  const names = current.names.slice(0, RELEASE269.migrationCount)
  const subset = (map) => new Map(names.map((name) => [name, map.get(name)]))
  const historical = {
    names,
    checksums: subset(current.checksums),
    ledgerChecksums: subset(current.ledgerChecksums),
    crlfLedgerChecksums: subset(current.crlfLedgerChecksums),
    hash: createHash('sha256')
      .update(`${names.map((name) => `${name} ${current.checksums.get(name)}`).join('\n')}\n`)
      .digest('hex'),
  }
  return assertRelease269Manifest(historical)
}
