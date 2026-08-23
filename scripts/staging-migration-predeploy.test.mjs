import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EXPECTED,
  VERIFIED_BASELINE_CHECKSUMS,
  assertApprovedTarget,
  assertFrozenManifest,
  ledgerState,
  remainingMigrationNames,
  readMigrationManifest,
} from './run-staging-migration-predeploy.mjs'

const approved = {
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
  RAILWAY_SERVICE_ID: EXPECTED.serviceId,
  DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
  PATHFINDER_STAGING_MIGRATION_APPROVAL: EXPECTED.approval,
  DATABASE_URL: 'postgresql://user:secret@pgvector.railway.internal:5432/pathfinder_staging',
  DIRECT_DATABASE_URL: 'postgresql://user:secret@pgvector.railway.internal:5432/pathfinder_staging',
}

test('accepts only the exact private Railway staging target', () => {
  assert.doesNotThrow(() => assertApprovedTarget(approved))
  for (const [field, value] of [
    ['RAILWAY_ENVIRONMENT_ID', 'production-id'],
    ['RAILWAY_SERVICE_ID', 'production-service'],
    ['DATABASE_RESOURCE_ID', 'production-database'],
    ['PATHFINDER_STAGING_MIGRATION_APPROVAL', 'wrong-approval'],
    ['DATABASE_URL', 'postgresql://user:secret@db.supabase.co:5432/postgres'],
  ]) {
    assert.throws(
      () => assertApprovedTarget({ ...approved, [field]: value }),
      /staging-migration-stop/u,
    )
  }
})

test('repository migration manifest remains frozen at the reviewed 151-file chain', async () => {
  const manifest = await readMigrationManifest('packages/db/prisma')
  assert.doesNotThrow(() => assertFrozenManifest(manifest))
  assert.throws(
    () => assertFrozenManifest({ ...manifest, hash: '0'.repeat(64) }),
    /manifest checksum changed/u,
  )
})

test('ledger accepts only exact reviewed baseline or final states', async () => {
  const manifest = await readMigrationManifest('packages/db/prisma')
  const rows = manifest.names.map((migration_name) => ({
    migration_name,
    checksum: manifest.checksums.get(migration_name),
    finished_at: new Date(),
    rolled_back_at: null,
    logs: null,
  }))
  assert.equal(ledgerState(rows.slice(0, EXPECTED.baselineCount), manifest), 'baseline')
  assert.equal(ledgerState(rows.slice(0, EXPECTED.priorCompleteCount), manifest), 'prior-complete')
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.capabilityBaselineCount), manifest),
    'capability-baseline',
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.stagingBaselineCount), manifest),
    'staging-baseline',
  )
  assert.equal(ledgerState(rows.slice(0, EXPECTED.preBillingCount), manifest), 'pre-billing')
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.billingFoundationCount), manifest),
    'billing-foundation',
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.previousReleaseCount), manifest),
    'previous-release',
  )
  assert.equal(ledgerState(rows.slice(0, EXPECTED.b5CompleteCount), manifest), 'b5-complete')
  assert.equal(ledgerState(rows, manifest), 'complete')
  const verifiedBaselineRows = rows.slice(0, EXPECTED.baselineCount).map((row) => ({
    ...row,
    checksum: VERIFIED_BASELINE_CHECKSUMS[row.migration_name] ?? row.checksum,
  }))
  assert.equal(ledgerState(verifiedBaselineRows, manifest), 'baseline')
  assert.throws(() => ledgerState(rows.slice(0, 53), manifest), /unexpected ledger row count/u)
  assert.throws(
    () => ledgerState(rows.slice(0, EXPECTED.previousReleaseCount - 1).concat(rows[134]), manifest),
    /ordering\/name mismatch/u,
  )
  assert.throws(
    () =>
      ledgerState(
        rows
          .slice(0, EXPECTED.previousReleaseCount)
          .map((row, index) =>
            index === EXPECTED.previousReleaseCount - 1
              ? { ...row, migration_name: '20260821032000_divergent_migration' }
              : row,
          ),
        manifest,
      ),
    /ordering\/name mismatch/u,
  )
  assert.throws(
    () =>
      ledgerState(
        rows
          .slice(0, EXPECTED.previousReleaseCount)
          .map((row, index) =>
            index === EXPECTED.previousReleaseCount - 1 ? { ...row, finished_at: null } : row,
          ),
        manifest,
      ),
    /unfinished migration/u,
  )
  assert.throws(
    () =>
      ledgerState(
        rows
          .slice(0, EXPECTED.previousReleaseCount)
          .map((row, index) =>
            index === EXPECTED.previousReleaseCount - 1
              ? { ...row, rolled_back_at: new Date() }
              : row,
          ),
        manifest,
      ),
    /rolled-back migration/u,
  )
  assert.throws(
    () =>
      ledgerState(
        rows
          .slice(0, EXPECTED.previousReleaseCount)
          .map((row, index) =>
            index === EXPECTED.previousReleaseCount - 1 ? { ...row, logs: 'failed' } : row,
          ),
        manifest,
      ),
    /migration logs are non-empty/u,
  )
  assert.throws(
    () => ledgerState(rows.concat(rows.at(-1)), manifest),
    /unexpected ledger row count/u,
  )
  assert.throws(
    () =>
      ledgerState(
        rows.map((row, index) => (index === 10 ? { ...row, checksum: 'bad' } : row)),
        manifest,
      ),
    /checksum mismatch/u,
  )
})

test('exact previous staging release advances only through the reviewed seventeen-migration suffix', async () => {
  const manifest = await readMigrationManifest('packages/db/prisma')
  const rows = manifest.names.map((migration_name) => ({
    migration_name,
    checksum: manifest.checksums.get(migration_name),
    finished_at: new Date(),
    rolled_back_at: null,
    logs: null,
  }))

  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.previousReleaseCount), manifest),
    [
      '20260821172000_add_verified_actor_audit',
      '20260821173500_add_approval_grants',
      '20260821190000_add_company_brain_crm_meetings',
      '20260821193000_add_portable_agent_workers',
      '20260821194500_add_company_knowledge_embeddings',
      '20260821200000_sync_mcp_credential_capabilities',
      '20260821201000_add_meeting_processing_capability',
      '20260822063000_add_google_source_retention_foundation',
      '20260822064500_add_calendar_meet_source_models',
      '20260822103000_add_prospect_staging_package_admission',
      '20260822104500_add_prospect_research_jobs',
      '20260822110000_add_prospect_followup_lineage',
      '20260822113000_add_staging_package_commit_state',
      '20260822120000_add_founder_control_room_reviews',
      '20260822223000_add_conversation_review_knowledge_draft_capabilities',
      '20260823021000_fix_offboarding_audit_trigger_enum_dispatch',
      '20260823030000_add_customer_access_requests',
    ],
  )
  assert.deepEqual(remainingMigrationNames(rows.slice(0, EXPECTED.b5CompleteCount), manifest), [
    '20260822063000_add_google_source_retention_foundation',
    '20260822064500_add_calendar_meet_source_models',
    '20260822103000_add_prospect_staging_package_admission',
    '20260822104500_add_prospect_research_jobs',
    '20260822110000_add_prospect_followup_lineage',
    '20260822113000_add_staging_package_commit_state',
    '20260822120000_add_founder_control_room_reviews',
    '20260822223000_add_conversation_review_knowledge_draft_capabilities',
    '20260823021000_fix_offboarding_audit_trigger_enum_dispatch',
    '20260823030000_add_customer_access_requests',
  ])
  assert.deepEqual(remainingMigrationNames(rows, manifest), [])
})
