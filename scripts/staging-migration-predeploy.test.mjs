import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  EXPECTED,
  VERIFIED_BASELINE_CHECKSUMS,
  assertApprovedTarget,
  assertStagingSchemaReadAdmission,
  admitPendingStagingMigrations,
  assertBackupEvidenceMatchesLedger,
  assertFrozenManifest,
  ledgerState,
  remainingMigrationNames as currentRemainingMigrationNames,
  readMigrationManifest as readCurrentMigrationManifest,
  expectedPublicTableCount,
} from './run-staging-migration-predeploy.mjs'

// The staging admission remains frozen at its separately reviewed 236-file
// manifest. Historical lineage tests use that exact prefix; the full local
// candidate must continue to fail admission until a new review is authorized.
async function readMigrationManifest(directory) {
  const current = await readCurrentMigrationManifest(directory)
  const names = current.names.slice(0, EXPECTED.migrationCount)
  const manifest = {
    ...current,
    names,
    hash: createHash('sha256')
      .update(`${names.map((name) => `${name} ${current.checksums.get(name)}`).join('\n')}\n`)
      .digest('hex'),
  }
  assertFrozenManifest(manifest)
  return manifest
}

test('the new local review migrations are not silently admitted by the frozen staging approval', async () => {
  const current = await readCurrentMigrationManifest('packages/db/prisma')
  assert.deepEqual(current.names.slice(EXPECTED.migrationCount), [
    '20260908170000_add_conversation_learning_review',
    '20260908180000_add_character_candidate_reviews',
    '20260909190000_sync_character_credential_capabilities',
    '20260909230000_add_intake_source_read_capability',
    '20260910080000_add_intake_source_agent_routing_policy',
    '20260910090000_add_intake_source_agent_dispatch',
    '20260910100000_add_semantic_conflict_resolution',
    '20260910110000_add_semantic_duplicate_resolution',
    '20260910120000_add_support_message_completion_outcome',
    '20260910130000_support_duplicate_outcome_exclusion',
    '20260910140000_add_semantic_reviewed_decline',
  ])
  assert.throws(() => assertFrozenManifest(current), /migration count changed/u)
  const reviewed = await readMigrationManifest('packages/db/prisma')
  assert.equal(reviewed.names.length, 236)
  assert.equal(EXPECTED.approval, 'torchiko-staging-lineage-to-236-20260908')
})

// Preserve the long historical suffix assertions below while the focused
// 234-to-236 assertions prove the newly admitted final migrations explicitly.
function remainingMigrationNames(rows, manifest) {
  return currentRemainingMigrationNames(rows, manifest).filter(
    (name) =>
      name !== '20260908150000_add_intake_v1_file_extraction_dispatches' &&
      name !== '20260908160000_add_agent_question_operations',
  )
}

const approved = {
  RAILWAY_ENVIRONMENT: 'staging',
  RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
  RAILWAY_SERVICE_ID: EXPECTED.serviceId,
  DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
  PATHFINDER_STAGING_MIGRATION_APPROVAL: EXPECTED.approval,
  DATABASE_URL: 'postgresql://user:secret@pgvector.railway.internal:5432/pathfinder_staging',
  DIRECT_DATABASE_URL: 'postgresql://user:secret@pgvector.railway.internal:5432/pathfinder_staging',
}

test('the measured workflow predecessor uses its own table count and unknown boundaries fail', () => {
  assert.equal(expectedPublicTableCount('workflow-activation-predecessor'), 248)
  assert.equal(expectedPublicTableCount('intake-processing-predecessor'), 252)
  assert.equal(expectedPublicTableCount('intake-package-predecessor'), 253)
  assert.equal(expectedPublicTableCount('intake-submission-predecessor'), 251)
  assert.equal(expectedPublicTableCount('staging-baseline'), 126)
  assert.equal(expectedPublicTableCount('b5-complete'), 193)
  assert.equal(expectedPublicTableCount('expiry-predecessor'), 255)
  assert.equal(expectedPublicTableCount('complete'), 256)
  for (const state of ['unknown', 'constructor', '__proto__'])
    assert.throws(() => expectedPublicTableCount(state), /unknown schema boundary/u)
})

test('code-only deployment reads exact current schema with migration gates closed', () => {
  const environment = {
    ...approved,
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    PATHFINDER_ALLOW_STAGING_MIGRATIONS: '0',
    PATHFINDER_STAGING_MIGRATION_APPROVAL: '',
  }
  assert.deepEqual(assertStagingSchemaReadAdmission(environment), { releaseSha: 'a'.repeat(40) })
  assert.equal(admitPendingStagingMigrations(environment, 'complete'), null)
  assert.throws(() => admitPendingStagingMigrations(environment, 'hosted-release'), /approval/u)
  assert.throws(
    () =>
      assertStagingSchemaReadAdmission({ ...environment, RAILWAY_ENVIRONMENT_ID: 'production' }),
    /identity mismatch/u,
  )
  assert.throws(
    () =>
      assertStagingSchemaReadAdmission({ ...environment, PATHFINDER_RELEASE_SHA: 'b'.repeat(40) }),
    /must equal/u,
  )
  assert.throws(
    () =>
      assertStagingSchemaReadAdmission({
        ...environment,
        RAILWAY_GIT_COMMIT_SHA: '',
        PATHFINDER_RELEASE_SHA: 'a'.repeat(40),
      }),
    /Local staging uploads/u,
  )
})

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

test('staging image pins the same exact migration approval as the predeploy', async () => {
  const dockerfile = await readFile('Dockerfile.web.staging', 'utf8')
  assert.match(
    dockerfile,
    new RegExp(`^ENV PATHFINDER_STAGING_MIGRATION_APPROVAL=${EXPECTED.approval}$`, 'mu'),
  )
})

test('staging image contains every local runtime dependency of the migration predeploy', async () => {
  const dockerfile = await readFile('Dockerfile.web.staging', 'utf8')
  const predeploy = await readFile('scripts/run-staging-migration-predeploy.mjs', 'utf8')
  const dependencies = [...predeploy.matchAll(/from '\.\/lib\/(?<dependency>[^']+\.mjs)'/gu)].map(
    (match) => match.groups.dependency,
  )
  assert.ok(dependencies.length > 0)
  for (const dependency of dependencies) {
    assert.match(
      dockerfile,
      new RegExp(
        `COPY --from=builder --chown=node:node /app/scripts/lib/${dependency} /migration/scripts/lib/${dependency}`,
        'u',
      ),
    )
  }
})

test('staging runbook requires the exact Railway service-level predeploy approval', async () => {
  const runbook = await readFile('docs/railway-staging.md', 'utf8')
  assert.match(runbook, /does not inherit Docker image `ENV`/u)
  assert.match(
    runbook,
    new RegExp(`PATHFINDER_STAGING_MIGRATION_APPROVAL=${EXPECTED.approval}`, 'u'),
  )
})

test('preserved-data backup evidence must match the live migration ledger boundary', () => {
  const rows = Array.from({ length: EXPECTED.migrationCount }, () => ({}))
  assert.doesNotThrow(() =>
    assertBackupEvidenceMatchesLedger(
      {
        dataPolicy: 'preserve-existing',
        backupEvidence: { ledgerCount: EXPECTED.migrationCount },
      },
      rows,
    ),
  )
  assert.throws(
    () =>
      assertBackupEvidenceMatchesLedger(
        { dataPolicy: 'preserve-existing', backupEvidence: { ledgerCount: 134 } },
        rows,
      ),
    /backup evidence ledger count/u,
  )
  assert.doesNotThrow(() =>
    assertBackupEvidenceMatchesLedger({ dataPolicy: 'synthetic-only', backupEvidence: null }, rows),
  )
})

test('repository migration manifest retains observed predecessors and the reviewed 236 suffix', async () => {
  const manifest = await readMigrationManifest('packages/db/prisma')
  assert.equal(EXPECTED.finalPublicTableCount, 256)
  assert.equal(EXPECTED.intakePackagePredecessorCount, 226)
  assert.equal(EXPECTED.intakePackagePredecessorPublicTableCount, 253)
  assert.equal(EXPECTED.sourceMappingPredecessorCount, 227)
  assert.equal(EXPECTED.sourceMappingPredecessorPublicTableCount, 254)
  assert.equal(EXPECTED.workflowActivationPredecessorCount, 223)
  assert.equal(EXPECTED.workflowActivationPredecessorPublicTableCount, 248)
  assert.equal(EXPECTED.legacyAdoptionPredecessorCount, 214)
  assert.equal(EXPECTED.legacyAdoptionPredecessorPublicTableCount, 238)
  assert.equal(EXPECTED.mediaResolutionPredecessorCount, 215)
  assert.equal(EXPECTED.mediaResolutionPredecessorPublicTableCount, 239)
  assert.equal(EXPECTED.mediaRelationPredecessorCount, 216)
  assert.equal(EXPECTED.mediaRelationPredecessorPublicTableCount, 240)
  assert.equal(EXPECTED.prospectOnboardingPredecessorCount, 218)
  assert.equal(EXPECTED.prospectOnboardingPredecessorPublicTableCount, 243)
  assert.equal(EXPECTED.governedMediaPredecessorCount, 219)
  assert.equal(EXPECTED.governedMediaPredecessorPublicTableCount, 243)
  assert.equal(EXPECTED.workflowRegistryPredecessorCount, 220)
  assert.equal(EXPECTED.workflowRegistryPredecessorPublicTableCount, 244)
  assert.equal(EXPECTED.usageObservationPredecessorCount, 221)
  assert.equal(EXPECTED.usageObservationPredecessorPublicTableCount, 244)
  assert.equal(EXPECTED.hostedPredecessorCount, 195)
  assert.equal(EXPECTED.hostedPredecessorPublicTableCount, 221)
  assert.equal(EXPECTED.venueMediaPredecessorCount, 196)
  assert.equal(EXPECTED.venueMediaPredecessorPublicTableCount, 225)
  assert.equal(EXPECTED.founderAbsencePredecessorCount, 199)
  assert.equal(EXPECTED.founderAbsencePredecessorPublicTableCount, 226)
  assert.equal(EXPECTED.founderAbsenceCompleteCount, 200)
  assert.equal(EXPECTED.founderAbsenceCompletePublicTableCount, 227)
  assert.equal(EXPECTED.replyReviewPredecessorCount, 205)
  assert.equal(EXPECTED.replyReviewPredecessorPublicTableCount, 231)
  assert.equal(EXPECTED.expiryPredecessorCount, 233)
  assert.equal(EXPECTED.expiryPredecessorPublicTableCount, 255)
  assert.equal(EXPECTED.websitePdfPredecessorCount, 234)
  assert.equal(EXPECTED.websitePdfPredecessorPublicTableCount, 255)
  assert.equal(
    EXPECTED.websitePdfPredecessorManifestHash,
    'fc4f9c47b4378fdd3abf2d598cdbcba2e3d2d1f0d86997102c9c0b72a5f767ab',
  )
  assert.equal(
    EXPECTED.expiryPredecessorManifestHash,
    '6b5b4a24aa848ec407a04f838bee72c8043ece15522762a7d016332c960edcfa',
  )
  assert.doesNotThrow(() => assertFrozenManifest(manifest))
  assert.throws(
    () => assertFrozenManifest({ ...manifest, hash: '0'.repeat(64) }),
    /manifest checksum changed/u,
  )
})

test('ledger accepts exact LF or CRLF Prisma checksums without weakening the normalized manifest freeze', async () => {
  const manifest = await readMigrationManifest('packages/db/prisma')
  const rawChecksumMigrations = manifest.names.filter(
    (name) => manifest.ledgerChecksums.get(name) !== manifest.checksums.get(name),
  )
  // Git may materialize migration.sql with LF or CRLF depending on checkout policy. The exact set
  // whose raw checksum differs is therefore not a release invariant; the normalized frozen manifest
  // and acceptance of each checkout's exact raw checksum are.
  for (const name of rawChecksumMigrations) {
    assert.match(manifest.ledgerChecksums.get(name), /^[a-f0-9]{64}$/u)
    assert.notEqual(manifest.ledgerChecksums.get(name), manifest.checksums.get(name))
  }
  const rows = manifest.names.map((migration_name) => ({
    migration_name,
    checksum: manifest.ledgerChecksums.get(migration_name),
    finished_at: new Date(),
    rolled_back_at: null,
    logs: null,
  }))
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.campaignPredecessorCount), manifest),
    'campaign-predecessor',
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.workflowActivationPredecessorCount), manifest),
    'workflow-activation-predecessor',
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.intakeProcessingPredecessorCount), manifest),
    'intake-processing-predecessor',
  )
  const websiteDiscoveryRows = rows.slice(0, EXPECTED.websiteDiscoveryPredecessorCount)
  assert.equal(websiteDiscoveryRows.length, 231)
  assert.equal(ledgerState(websiteDiscoveryRows, manifest), 'website-discovery-predecessor')
  assert.equal(expectedPublicTableCount('website-discovery-predecessor'), 254)
  assert.deepEqual(remainingMigrationNames(websiteDiscoveryRows, manifest), [
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  const corruptedWebsiteDiscoveryRows = websiteDiscoveryRows.map((row) => ({ ...row }))
  corruptedWebsiteDiscoveryRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(
    () => ledgerState(corruptedWebsiteDiscoveryRows, manifest),
    /ledger checksum mismatches/u,
  )
  const discussionRows = rows.slice(0, EXPECTED.discussionPredecessorCount)
  assert.equal(discussionRows.length, 232)
  assert.equal(ledgerState(discussionRows, manifest), 'discussion-predecessor')
  assert.equal(expectedPublicTableCount('discussion-predecessor'), 255)
  assert.deepEqual(remainingMigrationNames(discussionRows, manifest), [
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  const corruptedDiscussionRows = discussionRows.map((row) => ({ ...row }))
  corruptedDiscussionRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(() => ledgerState(corruptedDiscussionRows, manifest), /ledger checksum mismatches/u)
  const expiryRows = rows.slice(0, EXPECTED.expiryPredecessorCount)
  assert.equal(expiryRows.length, 233)
  assert.equal(ledgerState(expiryRows, manifest), 'expiry-predecessor')
  assert.equal(expectedPublicTableCount('expiry-predecessor'), 255)
  assert.deepEqual(remainingMigrationNames(expiryRows, manifest), [
    '20260908140000_add_website_pdf_collection_policy',
  ])
  const corruptedExpiryRows = expiryRows.map((row) => ({ ...row }))
  corruptedExpiryRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(() => ledgerState(corruptedExpiryRows, manifest), /ledger checksum mismatches/u)
  const websitePdfRows = rows.slice(0, EXPECTED.websitePdfPredecessorCount)
  assert.equal(websitePdfRows.length, 234)
  assert.equal(ledgerState(websitePdfRows, manifest), 'website-pdf-predecessor')
  assert.equal(expectedPublicTableCount('website-pdf-predecessor'), 255)
  assert.deepEqual(currentRemainingMigrationNames(websitePdfRows, manifest), [
    '20260908150000_add_intake_v1_file_extraction_dispatches',
    '20260908160000_add_agent_question_operations',
  ])
  const fileExtractionRows = rows.slice(0, EXPECTED.fileExtractionPredecessorCount)
  assert.equal(fileExtractionRows.length, 235)
  assert.equal(ledgerState(fileExtractionRows, manifest), 'file-extraction-predecessor')
  assert.equal(expectedPublicTableCount('file-extraction-predecessor'), 255)
  assert.deepEqual(currentRemainingMigrationNames(fileExtractionRows, manifest), [
    '20260908160000_add_agent_question_operations',
  ])
  const corruptFileExtractionRows = fileExtractionRows.map((row) => ({ ...row }))
  corruptFileExtractionRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(
    () => ledgerState(corruptFileExtractionRows, manifest),
    /ledger checksum mismatches/u,
  )
  const sourceMappingRows = rows.slice(0, EXPECTED.sourceMappingPredecessorCount)
  assert.equal(ledgerState(sourceMappingRows, manifest), 'source-mapping-predecessor')
  assert.equal(expectedPublicTableCount('source-mapping-predecessor'), 254)
  assert.deepEqual(remainingMigrationNames(sourceMappingRows, manifest), [
    '20260907190000_add_venue_location_primary_place',
    '20260908031000_release_answered_agent_execution_owner',
    '20260908044000_add_agent_outcome_question_provenance',
    '20260908080000_add_website_source_discovery',
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  assert.throws(() => ledgerState(rows.slice(0, 228), manifest), /unexpected ledger row count/u)
  const workerLifecycleRows = rows.slice(0, EXPECTED.workerLifecyclePredecessorCount)
  assert.equal(workerLifecycleRows.length, 229)
  const questionProvenanceRows = rows.slice(0, EXPECTED.questionProvenancePredecessorCount)
  assert.equal(questionProvenanceRows.length, 230)
  assert.equal(ledgerState(questionProvenanceRows, manifest), 'question-provenance-predecessor')
  assert.equal(expectedPublicTableCount('question-provenance-predecessor'), 254)
  assert.deepEqual(remainingMigrationNames(questionProvenanceRows, manifest), [
    '20260908080000_add_website_source_discovery',
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  const corruptedQuestionProvenanceRows = questionProvenanceRows.map((row) => ({ ...row }))
  corruptedQuestionProvenanceRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(
    () => ledgerState(corruptedQuestionProvenanceRows, manifest),
    /ledger checksum mismatches/u,
  )
  assert.equal(ledgerState(workerLifecycleRows, manifest), 'worker-lifecycle-predecessor')
  assert.equal(expectedPublicTableCount('worker-lifecycle-predecessor'), 254)
  assert.deepEqual(remainingMigrationNames(workerLifecycleRows, manifest), [
    '20260908044000_add_agent_outcome_question_provenance',
    '20260908080000_add_website_source_discovery',
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  const corruptedWorkerLifecycleRows = workerLifecycleRows.map((row) => ({ ...row }))
  corruptedWorkerLifecycleRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(
    () => ledgerState(corruptedWorkerLifecycleRows, manifest),
    /ledger checksum mismatches/u,
  )
  const corruptedSourceMappingRows = sourceMappingRows.map((row) => ({ ...row }))
  corruptedSourceMappingRows.at(-1).checksum = '0'.repeat(64)
  assert.throws(
    () => ledgerState(corruptedSourceMappingRows, manifest),
    /ledger checksum mismatches/u,
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.intakeProcessingPredecessorCount), manifest),
    [
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.intakePackagePredecessorCount), manifest),
    'intake-package-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.intakePackagePredecessorCount), manifest),
    [
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.intakeSubmissionPredecessorCount), manifest),
    'intake-submission-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.intakeSubmissionPredecessorCount), manifest),
    [
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.workflowActivationPredecessorCount), manifest),
    [
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.campaignPredecessorCount), manifest),
    [
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.legacyAdoptionPredecessorCount), manifest),
    'legacy-adoption-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.legacyAdoptionPredecessorCount), manifest),
    [
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.mediaResolutionPredecessorCount), manifest),
    'media-resolution-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.mediaResolutionPredecessorCount), manifest),
    [
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.mediaRelationPredecessorCount), manifest),
    'media-relation-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.mediaRelationPredecessorCount), manifest),
    [
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.prospectOnboardingPredecessorCount), manifest),
    'prospect-onboarding-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.prospectOnboardingPredecessorCount), manifest),
    [
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.governedMediaPredecessorCount), manifest),
    'governed-media-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.governedMediaPredecessorCount), manifest),
    [
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.workflowRegistryPredecessorCount), manifest),
    'workflow-registry-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.workflowRegistryPredecessorCount), manifest),
    [
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.usageObservationPredecessorCount), manifest),
    'usage-observation-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.usageObservationPredecessorCount), manifest),
    [
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.promotionAssessmentPredecessorCount), manifest),
    'promotion-assessment-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.promotionAssessmentPredecessorCount), manifest),
    [
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(ledgerState(rows, manifest), 'complete')
  const crlfRows = manifest.names.map((migration_name) => ({
    migration_name,
    checksum: manifest.crlfLedgerChecksums.get(migration_name),
    finished_at: new Date(),
    rolled_back_at: null,
    logs: null,
  }))
  assert.equal(ledgerState(crlfRows, manifest), 'complete')
  assert.notEqual(
    manifest.crlfLedgerChecksums.get('20260821172000_add_verified_actor_audit'),
    manifest.checksums.get('20260821172000_add_verified_actor_audit'),
  )
  assert.doesNotThrow(() => assertFrozenManifest(manifest))
})

test('ledger accepts only exact reviewed migration boundaries', async () => {
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
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.currentStagingCount), manifest),
    'current-staging',
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.hostedPredecessorCount), manifest),
    'hosted-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.hostedPredecessorCount), manifest),
    [
      '20260826010000_add_governed_venue_media',
      '20260826020000_add_venue_media_derivatives',
      '20260827220000_add_operational_performance_indexes',
      '20260828155000_allow_fenced_agent_bridge_takeover',
      '20260828174000_add_founder_absence_observations',
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.venueMediaPredecessorCount), manifest),
    'venue-media-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.venueMediaPredecessorCount), manifest),
    [
      '20260826020000_add_venue_media_derivatives',
      '20260827220000_add_operational_performance_indexes',
      '20260828155000_allow_fenced_agent_bridge_takeover',
      '20260828174000_add_founder_absence_observations',
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.performancePredecessorCount), manifest),
    'performance-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.performancePredecessorCount), manifest),
    [
      '20260828155000_allow_fenced_agent_bridge_takeover',
      '20260828174000_add_founder_absence_observations',
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.founderAbsencePredecessorCount), manifest),
    'founder-absence-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.founderAbsencePredecessorCount), manifest),
    [
      '20260828174000_add_founder_absence_observations',
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.founderAbsenceCompleteCount), manifest),
    'founder-absence-complete',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.founderAbsenceCompleteCount), manifest),
    [
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.replyReviewPredecessorCount), manifest),
    'reply-review-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.replyReviewPredecessorCount), manifest),
    [
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
  assert.equal(ledgerState(rows.slice(0, EXPECTED.hostedReleaseCount), manifest), 'hosted-release')
  assert.deepEqual(remainingMigrationNames(rows.slice(0, EXPECTED.hostedReleaseCount), manifest), [
    '20260901020000_support_tenant_wide_ai_accounting',
    '20260907000000_add_intake_submission_drafts',
    '20260907010000_add_character_factory_jobs',
    '20260907021000_add_universal_content_search_projection',
    '20260907021100_add_semantic_universal_content_handoff',
    '20260907021200_add_media_provider_operations',
    '20260907021300_add_venue_chat_derivative_bindings',
    '20260907021400_add_legacy_knowledge_adoption',
    '20260907021500_add_media_entity_resolution_revisions',
    '20260907021600_add_media_relation_applications',
    '20260907021700_add_media_temporal_review_receipts',
    '20260907021800_add_prospect_onboarding_delivery_attempts',
    '20260907021900_add_governed_guest_place_media_preferences',
    '20260907022000_add_agent_workflow_versions',
    '20260907022100_add_ai_usage_observation_status',
    '20260907022200_add_agent_workflow_promotion_assessments',
    '20260907022300_add_agent_workflow_activations',
    '20260907022400_add_intake_v1_submissions',
    '20260907022500_add_intake_v1_processing_dispatches',
    '20260907022600_add_intake_v1_package_handoffs',
    '20260907022700_add_intake_source_mapping_reviews',
    '20260907190000_add_venue_location_primary_place',
    '20260908031000_release_answered_agent_execution_owner',
    '20260908044000_add_agent_outcome_question_provenance',
    '20260908080000_add_website_source_discovery',
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  assert.equal(
    ledgerState(rows.slice(0, EXPECTED.campaignPredecessorCount), manifest),
    'campaign-predecessor',
  )
  assert.deepEqual(
    remainingMigrationNames(rows.slice(0, EXPECTED.campaignPredecessorCount), manifest),
    [
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
    ],
  )
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

test('exact previous staging release advances only through the reviewed migration suffix', async () => {
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
      '20260823060000_add_multi_venue_price_breakdowns',
      '20260823090000_add_email_attachment_retention_review',
      '20260823103000_add_platform_worker_policy_credentials',
      '20260823120000_add_job_record_venue_scope',
      '20260823150000_add_visitor_negative_feedback_insight',
      '20260823210000_add_location_proposal_capability',
      '20260823233000_add_agent_improvement_proposals',
      '20260824010000_add_agent_improvement_validation_evidence',
      '20260824120000_add_agent_run_cost_status',
      '20260824130000_add_policy_grant_idempotency',
      '20260824140000_add_approval_grant_evidence',
      '20260824150000_add_internal_support_drafts',
      '20260824160000_add_intake_machine_lineage',
      '20260824170000_add_weekly_report_draft_capability',
      '20260824180000_add_support_open_capability',
      '20260824190000_add_support_note_capability',
      '20260824200000_add_support_triage_capability',
      '20260824210000_add_support_information_request_capability',
      '20260824220000_add_support_completion_capability',
      '20260824230000_add_reviewable_package_evaluation_snapshot',
      '20260824230100_allow_reviewable_package_evaluation_snapshot',
      '20260824231000_add_support_package_approval_capability',
      '20260824233000_add_support_package_application_capability',
      '20260824234000_add_support_package_reversion_capability',
      '20260824235000_add_support_package_handoff_supersession',
      '20260825001000_add_operating_cost_evidence',
      '20260825002000_add_guest_answer_attributions',
      '20260825003000_add_retention_read_capability',
      '20260825004000_add_public_interest_intake',
      '20260825005000_add_public_interest_prospect_conversion',
      '20260825006000_add_platform_release_evidence',
      '20260825007000_add_operational_usage_evidence',
      '20260825008000_add_first_week_account_reviews',
      '20260825009000_add_founder_operating_exchanges',
      '20260825010000_add_agent_operational_trust_signals',
      '20260825010100_structure_agent_operational_trust_signals',
      '20260825011000_add_founder_directive_task_handoff',
      '20260825012000_align_agent_runtime_model_routing',
      '20260825013000_link_support_knowledge_proposals',
      '20260825014000_add_guest_answer_attribution_evaluator_workflow',
      '20260825160000_add_venue_response_depth',
      '20260825170000_add_knowledge_proposal_package_handoff',
      '20260825180000_add_knowledge_proposal_operational_update_handoff',
      '20260825220000_add_intake_website_research_receipts',
      '20260826010000_add_governed_venue_media',
      '20260826020000_add_venue_media_derivatives',
      '20260827220000_add_operational_performance_indexes',
      '20260828155000_allow_fenced_agent_bridge_takeover',
      '20260828174000_add_founder_absence_observations',
      '20260829032000_add_intake_file_extraction_receipts',
      '20260829165000_add_intake_file_extraction_reviews',
      '20260829220000_add_interview_clarification_resolutions',
      '20260829223000_add_file_clarification_resolutions',
      '20260829231500_enable_pdf_file_extraction',
      '20260830165000_add_prospect_inbound_reply_reviews',
      '20260901020000_support_tenant_wide_ai_accounting',
      '20260907000000_add_intake_submission_drafts',
      '20260907010000_add_character_factory_jobs',
      '20260907021000_add_universal_content_search_projection',
      '20260907021100_add_semantic_universal_content_handoff',
      '20260907021200_add_media_provider_operations',
      '20260907021300_add_venue_chat_derivative_bindings',
      '20260907021400_add_legacy_knowledge_adoption',
      '20260907021500_add_media_entity_resolution_revisions',
      '20260907021600_add_media_relation_applications',
      '20260907021700_add_media_temporal_review_receipts',
      '20260907021800_add_prospect_onboarding_delivery_attempts',
      '20260907021900_add_governed_guest_place_media_preferences',
      '20260907022000_add_agent_workflow_versions',
      '20260907022100_add_ai_usage_observation_status',
      '20260907022200_add_agent_workflow_promotion_assessments',
      '20260907022300_add_agent_workflow_activations',
      '20260907022400_add_intake_v1_submissions',
      '20260907022500_add_intake_v1_processing_dispatches',
      '20260907022600_add_intake_v1_package_handoffs',
      '20260907022700_add_intake_source_mapping_reviews',
      '20260907190000_add_venue_location_primary_place',
      '20260908031000_release_answered_agent_execution_owner',
      '20260908044000_add_agent_outcome_question_provenance',
      '20260908080000_add_website_source_discovery',
      '20260908120000_add_agent_question_discussion',
      '20260908130000_add_agent_question_expiry',
      '20260908140000_add_website_pdf_collection_policy',
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
    '20260823060000_add_multi_venue_price_breakdowns',
    '20260823090000_add_email_attachment_retention_review',
    '20260823103000_add_platform_worker_policy_credentials',
    '20260823120000_add_job_record_venue_scope',
    '20260823150000_add_visitor_negative_feedback_insight',
    '20260823210000_add_location_proposal_capability',
    '20260823233000_add_agent_improvement_proposals',
    '20260824010000_add_agent_improvement_validation_evidence',
    '20260824120000_add_agent_run_cost_status',
    '20260824130000_add_policy_grant_idempotency',
    '20260824140000_add_approval_grant_evidence',
    '20260824150000_add_internal_support_drafts',
    '20260824160000_add_intake_machine_lineage',
    '20260824170000_add_weekly_report_draft_capability',
    '20260824180000_add_support_open_capability',
    '20260824190000_add_support_note_capability',
    '20260824200000_add_support_triage_capability',
    '20260824210000_add_support_information_request_capability',
    '20260824220000_add_support_completion_capability',
    '20260824230000_add_reviewable_package_evaluation_snapshot',
    '20260824230100_allow_reviewable_package_evaluation_snapshot',
    '20260824231000_add_support_package_approval_capability',
    '20260824233000_add_support_package_application_capability',
    '20260824234000_add_support_package_reversion_capability',
    '20260824235000_add_support_package_handoff_supersession',
    '20260825001000_add_operating_cost_evidence',
    '20260825002000_add_guest_answer_attributions',
    '20260825003000_add_retention_read_capability',
    '20260825004000_add_public_interest_intake',
    '20260825005000_add_public_interest_prospect_conversion',
    '20260825006000_add_platform_release_evidence',
    '20260825007000_add_operational_usage_evidence',
    '20260825008000_add_first_week_account_reviews',
    '20260825009000_add_founder_operating_exchanges',
    '20260825010000_add_agent_operational_trust_signals',
    '20260825010100_structure_agent_operational_trust_signals',
    '20260825011000_add_founder_directive_task_handoff',
    '20260825012000_align_agent_runtime_model_routing',
    '20260825013000_link_support_knowledge_proposals',
    '20260825014000_add_guest_answer_attribution_evaluator_workflow',
    '20260825160000_add_venue_response_depth',
    '20260825170000_add_knowledge_proposal_package_handoff',
    '20260825180000_add_knowledge_proposal_operational_update_handoff',
    '20260825220000_add_intake_website_research_receipts',
    '20260826010000_add_governed_venue_media',
    '20260826020000_add_venue_media_derivatives',
    '20260827220000_add_operational_performance_indexes',
    '20260828155000_allow_fenced_agent_bridge_takeover',
    '20260828174000_add_founder_absence_observations',
    '20260829032000_add_intake_file_extraction_receipts',
    '20260829165000_add_intake_file_extraction_reviews',
    '20260829220000_add_interview_clarification_resolutions',
    '20260829223000_add_file_clarification_resolutions',
    '20260829231500_enable_pdf_file_extraction',
    '20260830165000_add_prospect_inbound_reply_reviews',
    '20260901020000_support_tenant_wide_ai_accounting',
    '20260907000000_add_intake_submission_drafts',
    '20260907010000_add_character_factory_jobs',
    '20260907021000_add_universal_content_search_projection',
    '20260907021100_add_semantic_universal_content_handoff',
    '20260907021200_add_media_provider_operations',
    '20260907021300_add_venue_chat_derivative_bindings',
    '20260907021400_add_legacy_knowledge_adoption',
    '20260907021500_add_media_entity_resolution_revisions',
    '20260907021600_add_media_relation_applications',
    '20260907021700_add_media_temporal_review_receipts',
    '20260907021800_add_prospect_onboarding_delivery_attempts',
    '20260907021900_add_governed_guest_place_media_preferences',
    '20260907022000_add_agent_workflow_versions',
    '20260907022100_add_ai_usage_observation_status',
    '20260907022200_add_agent_workflow_promotion_assessments',
    '20260907022300_add_agent_workflow_activations',
    '20260907022400_add_intake_v1_submissions',
    '20260907022500_add_intake_v1_processing_dispatches',
    '20260907022600_add_intake_v1_package_handoffs',
    '20260907022700_add_intake_source_mapping_reviews',
    '20260907190000_add_venue_location_primary_place',
    '20260908031000_release_answered_agent_execution_owner',
    '20260908044000_add_agent_outcome_question_provenance',
    '20260908080000_add_website_source_discovery',
    '20260908120000_add_agent_question_discussion',
    '20260908130000_add_agent_question_expiry',
    '20260908140000_add_website_pdf_collection_policy',
  ])
  assert.deepEqual(remainingMigrationNames(rows, manifest), [])
})
