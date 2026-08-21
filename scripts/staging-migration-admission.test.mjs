import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertStagingMigrationAdmission,
  stagingMigrationPolicy,
} from './lib/staging-migration-admission.mjs'

const releaseSha = 'a'.repeat(40)
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
  })
  assert.equal(stagingMigrationPolicy.maximumSpendUsd, 10)
})

test('admits an explicitly approved local upload when Railway has no Git SHA', () => {
  assert.deepEqual(
    assertStagingMigrationAdmission({
      ...admitted,
      RAILWAY_GIT_COMMIT_SHA: undefined,
      PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL:
        'torchiko-stripe-billing-local-upload-20260820',
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
  ['non-synthetic policy', { PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'production-lineage' }],
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
