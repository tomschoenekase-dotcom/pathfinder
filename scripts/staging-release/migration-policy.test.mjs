import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ADMITTED_STAGING_MIGRATION_SUFFIX,
  evaluatePreserveExistingMigration,
  inspectDestructiveStatements,
  migrationSqlSha256,
} from './migration-policy.mjs'
import { buildProposedTargetBaseline } from './target-baseline.mjs'

const now = '2026-09-28T12:00:00.000Z'
const releaseSha = 'd'.repeat(40)
const targetResourceId = 'synthetic-resource-id'
const previousMigration = '20260918190000_add_agent_routines'
const previousChecksum = 'e'.repeat(64)
const prefix = Array.from({ length: 249 }, (_, index) => ({
  name: `20260101${String(index).padStart(6, '0')}_fixture_${String(index).padStart(3, '0')}`,
  checksum: 'a'.repeat(64),
}))
prefix.push({ name: previousMigration, checksum: previousChecksum })

const observed = () => ({
  railwayDatabaseResourceId: targetResourceId,
  systemIdentifier: '739184002001',
  databaseOid: 16384,
  databaseName: 'pathfinder_staging_fixture',
  finishedMigrations: prefix,
  tableRowCounts: [{ schema: 'public', tableName: 'venues', rowCount: '12' }],
  unresolvedMigrationAttempts: 0,
})

const acceptedBaseline = () => ({
  ...buildProposedTargetBaseline(observed()),
  status: 'accepted',
  acceptance: { approvedBy: 'Tom', approvedAt: now },
})

const loadAdmittedSql = async () =>
  Promise.all(
    ADMITTED_STAGING_MIGRATION_SUFFIX.map(async ({ name }) => ({
      migrationName: name,
      sql: await readFile(
        new URL(`../../packages/db/prisma/migrations/${name}/migration.sql`, import.meta.url),
        'utf8',
      ),
    })),
  )

const validProof = () => ({
  verified: true,
  disposableRestoreVerified: true,
  releaseSha,
  databaseResourceId: targetResourceId,
  backupStorageResourceId: 'synthetic-backup-storage-id',
  disposableDatabaseResourceId: 'pathfinder_disposable_restore_fixture',
  createdAt: '2026-09-28T11:00:00.000Z',
  restoreVerifiedAt: '2026-09-28T11:30:00.000Z',
  archiveSha256: 'b'.repeat(64),
  restoreProofSha256: 'c'.repeat(64),
  ledgerCount: 250,
})

const reviewedStatements = (migrationSql) =>
  migrationSql.flatMap(({ migrationName, sql }) =>
    inspectDestructiveStatements(migrationName, sql).map((finding) => ({
      statementId: finding.statementId,
      statementName: `Release-card entry ${finding.statementId} reviewed for safe constraint expansion`,
      sha256: finding.sha256,
    })),
  )

test('preserve-existing admits only the exact reviewed suffix for a disposable preflight', async () => {
  const migrationSql = await loadAdmittedSql()
  const input = {
    targetBaseline: acceptedBaseline(),
    observedTarget: observed(),
    unresolvedMigrationAttempts: 0,
    releaseSha,
    now,
    pendingMigrations: ADMITTED_STAGING_MIGRATION_SUFFIX,
    migrationSql,
    reviewedDestructiveStatements: reviewedStatements(migrationSql),
    preservationProof: validProof(),
  }
  assert.deepEqual(evaluatePreserveExistingMigration(input), {
    ok: true,
    executionScope: 'disposable-preflight-only',
    hostedExecutionAllowed: false,
    admittedMigrationNames: ADMITTED_STAGING_MIGRATION_SUFFIX.map(({ name }) => name),
  })
})

test('missing, stale, wrong-release, same-target and ledger-mismatched recovery evidence rejects', async () => {
  const migrationSql = await loadAdmittedSql()
  const input = {
    targetBaseline: acceptedBaseline(),
    observedTarget: observed(),
    unresolvedMigrationAttempts: 0,
    releaseSha,
    now,
    pendingMigrations: ADMITTED_STAGING_MIGRATION_SUFFIX,
    migrationSql,
    reviewedDestructiveStatements: reviewedStatements(migrationSql),
    preservationProof: validProof(),
  }
  const rejected = [
    { preservationProof: null },
    { preservationProof: { ...validProof(), restoreVerifiedAt: '2026-09-26T11:30:00.000Z' } },
    { preservationProof: { ...validProof(), releaseSha: 'f'.repeat(40) } },
    { preservationProof: { ...validProof(), disposableDatabaseResourceId: targetResourceId } },
    { preservationProof: { ...validProof(), ledgerCount: 249 } },
    { unresolvedMigrationAttempts: 1 },
  ]
  for (const patch of rejected) {
    assert.throws(
      () => evaluatePreserveExistingMigration({ ...input, ...patch }),
      /migration-policy-/u,
    )
  }
})

test('only the exact two migration names and checksums are admitted in order', () => {
  const base = {
    targetBaseline: acceptedBaseline(),
    observedTarget: observed(),
    unresolvedMigrationAttempts: 0,
    releaseSha,
    now,
    pendingMigrations: ADMITTED_STAGING_MIGRATION_SUFFIX,
    migrationSql: [],
    reviewedDestructiveStatements: [],
    preservationProof: validProof(),
  }
  for (const pendingMigrations of [
    [...ADMITTED_STAGING_MIGRATION_SUFFIX].reverse(),
    [...ADMITTED_STAGING_MIGRATION_SUFFIX, { name: 'extra', checksum: 'f'.repeat(64) }],
    [
      { ...ADMITTED_STAGING_MIGRATION_SUFFIX[0], checksum: 'f'.repeat(64) },
      ADMITTED_STAGING_MIGRATION_SUFFIX[1],
    ],
  ])
    assert.throws(
      () => evaluatePreserveExistingMigration({ ...base, pendingMigrations }),
      /migration-policy-/u,
    )
})

test('destructive SQL requires an exact statement hash and an explicit review name', async () => {
  const migrationSql = await loadAdmittedSql()
  const findings = migrationSql.flatMap(({ migrationName, sql }) =>
    inspectDestructiveStatements(migrationName, sql),
  )
  assert.equal(findings.length, 3)
  const input = {
    targetBaseline: acceptedBaseline(),
    observedTarget: observed(),
    unresolvedMigrationAttempts: 0,
    releaseSha,
    now,
    pendingMigrations: ADMITTED_STAGING_MIGRATION_SUFFIX,
    migrationSql,
    reviewedDestructiveStatements: [],
    preservationProof: validProof(),
  }
  assert.throws(
    () => evaluatePreserveExistingMigration(input),
    /migration-policy-unreviewed-destructive-statement/u,
  )
  const reviewed = findings.map((finding) => ({
    statementId: finding.statementId,
    statementName: `Release-card entry ${finding.statementId} reviewed for capability expansion`,
    sha256: finding.sha256,
  }))
  assert.equal(
    evaluatePreserveExistingMigration({ ...input, reviewedDestructiveStatements: reviewed }).ok,
    true,
  )
  assert.throws(
    () =>
      evaluatePreserveExistingMigration({
        ...input,
        reviewedDestructiveStatements: [{ ...reviewed[0], sha256: '0'.repeat(64) }, ...reviewed.slice(1)],
      }),
    /migration-policy-review-hash-mismatch/u,
  )
  assert.throws(
    () =>
      evaluatePreserveExistingMigration({
        ...input,
        reviewedDestructiveStatements: [{ ...reviewed[0], statementName: '' }, ...reviewed.slice(1)],
      }),
    /migration-policy-review-name-required/u,
  )
  assert.throws(
    () =>
      evaluatePreserveExistingMigration({
        ...input,
        reviewedDestructiveStatements: [
          reviewed[0],
          { ...reviewed[1], statementName: reviewed[0].statementName },
          reviewed[2],
        ],
      }),
    /migration-policy-duplicate-review-name/u,
  )
})

test('SQL scanner ignores destructive words in comments and string literals', () => {
  const sql = `-- DROP TABLE customers;\nSELECT 'DELETE FROM venues;'; /* TRUNCATE users; */ SELECT 1;`
  assert.deepEqual(inspectDestructiveStatements('synthetic_migration', sql), [])
  assert.equal(migrationSqlSha256(sql).length, 64)
})

test('procedural SQL requires explicit review even when destructive text is dollar quoted', () => {
  const sql = "DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;"
  assert.equal(inspectDestructiveStatements('synthetic_migration', sql)[0]?.kind, 'procedural-sql')
})
