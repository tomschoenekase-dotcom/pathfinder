import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import {
  assertStagingMigrationAdmission,
  stagingMigrationPolicy,
} from './lib/staging-migration-admission.mjs'

const releaseSha = 'a'.repeat(40)
const now = new Date('2026-08-23T12:00:00.000Z')
const admitted = {
  RAILWAY_ENVIRONMENT: 'staging',
  PATHFINDER_ALLOW_STAGING_MIGRATIONS: '1',
  PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'synthetic-only',
  PATHFINDER_STAGING_SPEND_CEILING_USD: '10',
  PATHFINDER_RELEASE_SHA: releaseSha,
  RAILWAY_GIT_COMMIT_SHA: releaseSha,
  PATHFINDER_STAGING_DATABASE_RESOURCE: 'railway-staging-postgres-20260819',
  PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: 'railway-staging-postgres-20260819',
  DATABASE_URL: 'postgresql://staging:secret@pool.staging.internal:5432/pathfinder_staging',
  DIRECT_DATABASE_URL:
    'postgresql://staging:secret@direct.staging.internal:5432/pathfinder_staging',
  PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'pool.staging.internal',
  PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'direct.staging.internal',
  PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'pathfinder_staging',
}

test('admits only the exact approved staging release and target', () => {
  assert.deepEqual(assertStagingMigrationAdmission(admitted), {
    releaseSha,
    resource: 'railway-staging-postgres-20260819',
    databaseHost: 'pool.staging.internal',
    directDatabaseHost: 'direct.staging.internal',
    database: 'pathfinder_staging',
    spendCeilingUsd: 10,
    dataPolicy: 'synthetic-only',
    backupEvidence: null,
  })
  assert.equal(stagingMigrationPolicy.maximumSpendUsd, 10)
})

test('migration wrapper reports the admitted data policy without rewriting it', async () => {
  const source = await readFile(new URL('./migrate-staging-db.mjs', import.meta.url), 'utf8')

  assert.match(source, /dataPolicy: admission\.dataPolicy/u)
  assert.doesNotMatch(source, /dataPolicy: 'synthetic-only'/u)
})

test('admits preserved staging data only with fresh separately stored backup and restore proof', () => {
  const preserved = {
    ...admitted,
    PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'preserve-existing',
    PATHFINDER_STAGING_BACKUP_RELEASE_SHA: releaseSha,
    PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE: admitted.PATHFINDER_STAGING_DATABASE_RESOURCE,
    PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE: 'railway-staging-backup-volume-20260823',
    PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE: 'railway-staging-backup-volume-20260823',
    PATHFINDER_STAGING_BACKUP_LEDGER_COUNT: '159',
    PATHFINDER_STAGING_BACKUP_CREATED_AT: '2026-08-23T10:00:00.000Z',
    PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT: '2026-08-23T11:00:00.000Z',
    PATHFINDER_STAGING_BACKUP_SHA256: 'b'.repeat(64),
    PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256: 'c'.repeat(64),
  }
  assert.deepEqual(assertStagingMigrationAdmission(preserved, now).backupEvidence, {
    archiveSha256: 'b'.repeat(64),
    restoreProofSha256: 'c'.repeat(64),
    storageResource: 'railway-staging-backup-volume-20260823',
    ledgerCount: 159,
    createdAt: '2026-08-23T10:00:00.000Z',
    restoreVerifiedAt: '2026-08-23T11:00:00.000Z',
  })

  for (const patch of [
    { PATHFINDER_STAGING_BACKUP_RELEASE_SHA: 'd'.repeat(40) },
    { PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE: 'another-database' },
    {
      PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE: admitted.PATHFINDER_STAGING_DATABASE_RESOURCE,
      PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE:
        admitted.PATHFINDER_STAGING_DATABASE_RESOURCE,
    },
    { PATHFINDER_STAGING_BACKUP_LEDGER_COUNT: '0' },
    { PATHFINDER_STAGING_BACKUP_CREATED_AT: '2026-08-22T10:00:00.000Z' },
    { PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT: '2026-08-23T09:00:00.000Z' },
    { PATHFINDER_STAGING_BACKUP_SHA256: 'not-a-hash' },
    { PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256: 'not-a-hash' },
  ]) {
    assert.throws(() => assertStagingMigrationAdmission({ ...preserved, ...patch }, now))
  }
})

test('admits an explicitly approved local upload when Railway has no Git SHA', () => {
  assert.deepEqual(
    assertStagingMigrationAdmission({
      ...admitted,
      RAILWAY_GIT_COMMIT_SHA: undefined,
      PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL: 'torchiko-stripe-billing-local-upload-20260820',
    }),
    assertStagingMigrationAdmission(admitted),
  )
})

test('rejects a local upload without the exact one-time approval', () => {
  assert.throws(
    () =>
      assertStagingMigrationAdmission({
        ...admitted,
        RAILWAY_GIT_COMMIT_SHA: undefined,
      }),
    /one-time PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL/u,
  )
})

for (const [name, patch] of [
  ['wrong environment', { RAILWAY_ENVIRONMENT: 'production' }],
  ['missing opt-in', { PATHFINDER_ALLOW_STAGING_MIGRATIONS: undefined }],
  ['unreviewed data policy', { PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'production-lineage' }],
  ['over budget', { PATHFINDER_STAGING_SPEND_CEILING_USD: '10.01' }],
  ['release mismatch', { RAILWAY_GIT_COMMIT_SHA: 'b'.repeat(40) }],
  [
    'resource mismatch',
    { PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: 'another-staging-resource' },
  ],
  ['database mismatch', { PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'postgres' }],
  ['pooled host mismatch', { PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'wrong.internal' }],
  ['direct host mismatch', { PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'wrong.internal' }],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertStagingMigrationAdmission({ ...admitted, ...patch }))
  })
}

test('rejects the known production project in URLs or resource identity', () => {
  for (const patch of [
    {
      DATABASE_URL:
        'postgresql://user:secret@db.zpacmfkomonxeqdiadtz.supabase.co:5432/pathfinder_staging',
      PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'db.zpacmfkomonxeqdiadtz.supabase.co',
    },
    {
      PATHFINDER_STAGING_DATABASE_RESOURCE: 'zpacmfkomonxeqdiadtz',
      PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: 'zpacmfkomonxeqdiadtz',
    },
  ]) {
    assert.throws(
      () => assertStagingMigrationAdmission({ ...admitted, ...patch }),
      /production project/u,
    )
  }
})
