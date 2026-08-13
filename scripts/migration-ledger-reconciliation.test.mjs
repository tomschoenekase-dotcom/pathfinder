import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AFFECTED_MIGRATIONS,
  reconcileAffectedMigrationLedger,
} from './lib/migration-ledger-reconciliation.mjs'

const expectedChecksums = Object.fromEntries(
  AFFECTED_MIGRATIONS.map((migration, index) => [migration, String(index).padStart(64, '0')]),
)

function finished(migration) {
  return {
    migration_name: migration,
    checksum: expectedChecksums[migration],
    finished_at: '2026-08-12T00:00:00Z',
    rolled_back_at: null,
  }
}

test('classifies an environment with no affected rows as a clean pre-chain candidate', () => {
  assert.equal(reconcileAffectedMigrationLedger({ rows: [], expectedChecksums }).decision, 'clean')
})

test('stops on a successful historical checksum mismatch', () => {
  const row = { ...finished(AFFECTED_MIGRATIONS[1]), checksum: 'f'.repeat(64) }
  const result = reconcileAffectedMigrationLedger({ rows: [row], expectedChecksums })
  assert.equal(result.decision, 'stop')
  assert.equal(result.findings[1].checksum, 'mismatch')
})

test('stops on a failed or still-running affected migration', () => {
  const row = { ...finished(AFFECTED_MIGRATIONS[0]), finished_at: null }
  assert.equal(
    reconcileAffectedMigrationLedger({ rows: [row], expectedChecksums }).decision,
    'stop',
  )
})

test('stops when an old successor is finished without its new predecessor', () => {
  const result = reconcileAffectedMigrationLedger({
    rows: [finished('20260811235950_add_onboarding_bootstrap_intake')],
    expectedChecksums,
  })
  assert.equal(result.decision, 'stop')
})

test('requires review when all affected rows match the current chain', () => {
  const result = reconcileAffectedMigrationLedger({
    rows: AFFECTED_MIGRATIONS.map(finished),
    expectedChecksums,
  })
  assert.equal(result.decision, 'review')
  assert.ok(result.findings.every((finding) => finding.checksum === 'match'))
})

test('rejects duplicate or malformed evidence without exposing logs', () => {
  const row = { ...finished(AFFECTED_MIGRATIONS[0]), logs: 'private-marker' }
  assert.throws(
    () =>
      reconcileAffectedMigrationLedger({
        rows: [row, row],
        expectedChecksums,
      }),
    (error) =>
      error.message === 'duplicate-ledger-migration' && !error.message.includes('private-marker'),
  )
})
