import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildProposedTargetBaseline,
  compareTargetBaseline,
  migrationLedgerSha256,
  tableCountsSha256,
  targetBaselineSql,
  exactTableCountSql,
} from './target-baseline.mjs'

const observation = () => ({
  railwayDatabaseResourceId: 'synthetic-resource-id',
  systemIdentifier: '739184002001',
  databaseOid: 16384,
  databaseName: 'pathfinder_staging_fixture',
  finishedMigrations: [
    { name: '20260101000000_create_fixture', checksum: 'a'.repeat(64) },
    { name: '20260102000000_extend_fixture', checksum: 'b'.repeat(64) },
  ],
  tableRowCounts: [
    { schema: 'public', tableName: 'tenants', rowCount: '10' },
    { schema: 'public', tableName: 'venues', rowCount: '12' },
  ],
  unresolvedMigrationAttempts: 0,
})

const acceptedBaseline = (state = observation()) => ({
  ...buildProposedTargetBaseline(state),
  status: 'accepted',
  acceptance: { approvedBy: 'Tom', approvedAt: '2026-09-28T12:00:00.000Z' },
})

test('a proposed baseline is a separate artifact and must be accepted before comparison', () => {
  const proposed = buildProposedTargetBaseline(observation())
  assert.equal(proposed.status, 'proposed')
  assert.throws(() => compareTargetBaseline(null, observation()), /target-baseline-missing/u)
  assert.throws(
    () => compareTargetBaseline(proposed, observation()),
    /target-baseline-not-accepted/u,
  )
  assert.equal(compareTargetBaseline(acceptedBaseline(), observation()).ok, true)
})

test('baseline comparison fails closed on every target identity and preservation fingerprint', () => {
  const baseline = acceptedBaseline()
  const changed = [
    { railwayDatabaseResourceId: 'other-resource' },
    { systemIdentifier: '739184002002' },
    { databaseOid: 16385 },
    { databaseName: 'other_database' },
    {
      finishedMigrations: [
        { ...observation().finishedMigrations[0], checksum: 'c'.repeat(64) },
        observation().finishedMigrations[1],
      ],
    },
    {
      finishedMigrations: [
        { ...observation().finishedMigrations[0], checksum: 'c'.repeat(64) },
        observation().finishedMigrations[1],
      ],
    },
    {
      tableRowCounts: [
        { schema: 'public', tableName: 'tenants', rowCount: '11' },
        observation().tableRowCounts[1],
      ],
    },
  ]
  for (const patch of changed) {
    assert.throws(
      () => compareTargetBaseline(baseline, { ...observation(), ...patch }),
      /target-baseline-mismatch/u,
    )
  }
})

test('ledger and per-table fingerprints are deterministic, order-aware and validate inputs', () => {
  const state = observation()
  assert.equal(
    migrationLedgerSha256(state.finishedMigrations),
    migrationLedgerSha256(state.finishedMigrations),
  )
  assert.notEqual(
    migrationLedgerSha256(state.finishedMigrations),
    migrationLedgerSha256([
      { ...state.finishedMigrations[0], checksum: 'c'.repeat(64) },
      state.finishedMigrations[1],
    ]),
  )
  assert.throws(
    () => migrationLedgerSha256([...state.finishedMigrations].reverse()),
    /invalid-target-observation/u,
  )
  assert.equal(
    tableCountsSha256(state.tableRowCounts),
    tableCountsSha256([...state.tableRowCounts].reverse()),
  )
  assert.throws(
    () => migrationLedgerSha256([{ name: 'invalid', checksum: 'bad' }]),
    /invalid-target-observation/u,
  )
  assert.throws(
    () => buildProposedTargetBaseline({ ...state, tableRowCounts: [] }),
    /invalid-target-observation/u,
  )
})

test('baseline SQL reads identities, finished ledger and counts without row content or writes', () => {
  assert.match(targetBaselineSql.systemIdentity, /pg_control_system\(\)/u)
  assert.match(targetBaselineSql.finishedMigrations, /finished_at IS NOT NULL/u)
  assert.match(targetBaselineSql.finishedMigrations, /rolled_back_at IS NULL/u)
  assert.match(targetBaselineSql.tableInventory, /table_schema = 'public'/u)
  assert.doesNotMatch(targetBaselineSql.tableInventory, /INSERT|UPDATE|DELETE|DROP|TRUNCATE/iu)
  assert.equal(
    exactTableCountSql('public', 'venue_archive'),
    'SELECT count(*)::text AS row_count FROM "public"."venue_archive"',
  )
  assert.throws(() => exactTableCountSql('public', 'venue"archive'), /invalid-table-identity/u)
  assert.throws(() => exactTableCountSql('private', 'venues'), /invalid-table-identity/u)
})
