import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { assertRelease269Ledger, RELEASE269 } from './release269-migration-contract.mjs'
import {
  assertProductionMigrationTarget,
  PRODUCTION_DATABASE,
} from './production-migration-admission.mjs'
import {
  EXPECTED as HISTORICAL267,
  assertStagingSchemaReadAdmission,
  assertStagingApplicationPolicy,
  readStagingApplicationPolicy,
  withStagingApplicationHold,
} from '../run-staging-migration-predeploy.mjs'
import { assertStagingMigrationAdmission } from './staging-migration-admission.mjs'

export const RELEASE269_APPROVAL = 'torchiko-staging-lineage-to-269-20261026'
export const RELEASE269_PROOF_SCHEMA = 'torchiko-release269-preservation/v1'
const SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const ROLLBACK_NAME = '20260912080000_add_guest_conversation_disposition'
export const hashJson = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const exactHash = (value) => assert.match(value ?? '', HASH, 'release269-hash-required')

export function release269Target(environment, target, releaseSha) {
  assert.match(releaseSha ?? '', SHA, 'release269-full-sha-required')
  if (target === 'staging') {
    assert.equal(assertStagingSchemaReadAdmission(environment).releaseSha, releaseSha)
    return HISTORICAL267.databaseResourceId
  }
  assert.equal(target, 'production', 'release269-target-refused')
  assertProductionMigrationTarget(environment)
  return PRODUCTION_DATABASE
}

// Rolled-back physical rows are explicitly reconciled with a separately reviewed
// receipt. They are retained and compared in full; they are never silently dropped.
export function reconcileRelease269Ledger(snapshot, manifest, proof) {
  assert.ok(Array.isArray(snapshot.ledger), 'release269-physical-ledger-required')
  for (const row of snapshot.ledger) {
    assert.ok(typeof row.id === 'string' && row.id.length > 0, 'release269-ledger-id-required')
    exactHash(row.rowHash)
  }
  assert.equal(new Set(snapshot.ledger.map((row) => row.id)).size, snapshot.ledger.length)
  const historical = snapshot.ledger.filter((row) => row.rolled_back_at !== null)
  assert.ok(Array.isArray(proof.historicalRollbackRows), 'release269-rollback-evidence-required')
  assert.ok(historical.length <= 1, 'release269-unknown-rollback-history')
  for (const row of historical) {
    assert.equal(row.migration_name, ROLLBACK_NAME, 'release269-unknown-rollback-history')
    exactHash(row.rowHash)
    assert.ok(Number.isFinite(Date.parse(row.rolled_back_at)), 'release269-invalid-rollback-time')
  }
  assert.deepEqual(
    historical.map(({ id, rowHash }) => ({ id, rowHash })),
    proof.historicalRollbackRows,
    'release269-rollback-history-mismatch',
  )
  const active = snapshot.ledger.filter((row) => row.rolled_back_at === null)
  const result = assertRelease269Ledger(active, manifest)
  assert.equal(snapshot.activeLedgerCount, active.length)
  assert.equal(snapshot.physicalLedgerCount, snapshot.ledger.length)
  return result.state
}

export function assertRelease269Snapshot(snapshot, { target, releaseSha, resource }) {
  assert.equal(snapshot.schema, RELEASE269_PROOF_SCHEMA)
  assert.equal(snapshot.target, target)
  assert.equal(snapshot.releaseSha, releaseSha)
  assert.equal(snapshot.databaseResource, resource)
  assert.equal(snapshot.manifestHash, RELEASE269.manifestHash)
  assert.equal(snapshot.publicTableCount, RELEASE269.publicTableCount)
  assert.equal(snapshot.invalidIndexes, 0, 'release269-invalid-indexes')
  assert.equal(snapshot.unvalidatedConstraints, 0, 'release269-unvalidated-constraints')
  assert.equal(
    snapshot.weeklyDigestFingerprintValid,
    true,
    'release269-weekly-fingerprint-required',
  )
  assert.equal(snapshot.disabledAppPlansValid, true, 'release269-app-plans-refused')
  assert.ok(Array.isArray(snapshot.tables) && snapshot.tables.length === 296)
  assert.equal(new Set(snapshot.tables.map((row) => row.name)).size, 296)
  for (const row of snapshot.tables) {
    assert.match(row.count ?? '', /^\d+$/u)
    exactHash(row.hash)
    assert.ok(Array.isArray(row.columns) && row.columns.length > 0)
  }
  exactHash(snapshot.dataHash)
  assert.equal(snapshot.dataHash, hashJson(snapshot.tables), 'release269-data-hash-mismatch')
  exactHash(snapshot.physicalLedgerHash)
  exactHash(snapshot.schemaHash)
  for (const key of [
    'policyHash',
    'sequenceStateHash',
    'securityHash',
    'newFunctionPrivilegesHash',
  ])
    exactHash(snapshot[key])
  assert.ok(Array.isArray(snapshot.security), 'release269-security-evidence-required')
  assert.equal(snapshot.securityHash, hashJson(snapshot.security))
  assert.equal(new Set(snapshot.security.map((row) => row.identity)).size, snapshot.security.length)
  for (const row of snapshot.security) exactHash(row.hash)
  assert.equal(
    snapshot.physicalLedgerHash,
    hashJson(snapshot.ledger.map(({ id, rowHash }) => ({ id, rowHash }))),
  )
}

function timestamp(value) {
  assert.equal(typeof value, 'string', 'release269-timestamp-required')
  const time = Date.parse(value)
  assert.ok(
    Number.isFinite(time) && new Date(time).toISOString() === value,
    'release269-timestamp-invalid',
  )
  return time
}

export function assertRelease269Backup(proof, snapshot, { target, releaseSha, resource, now }) {
  assert.equal(proof.schema, RELEASE269_PROOF_SCHEMA)
  assert.equal(proof.target, target)
  assert.equal(proof.releaseSha, releaseSha)
  assert.equal(proof.databaseResource, resource)
  assert.equal(proof.manifestHash, RELEASE269.manifestHash)
  assert.equal(proof.dataPolicy, 'preserve-existing')
  assert.equal(proof.migrationScope, '267-to-269-zero-event-rewrite')
  assert.equal(proof.approved, true, 'release269-reviewed-proof-required')
  assert.ok(
    typeof proof.backupStorageResource === 'string' && proof.backupStorageResource.length > 0,
  )
  assert.notEqual(proof.backupStorageResource, resource, 'release269-independent-backup-required')
  if (target === 'staging') assert.ok(!proof.backupStorageResource.includes(PRODUCTION_DATABASE))
  for (const key of [
    'backupSha256',
    'restoreProofSha256',
    'rehearsalProofSha256',
    'ownershipAclArchiveEvidenceSha256',
    'restoreOwnershipAclRemappingSha256',
  ])
    exactHash(proof[key])
  assert.equal(proof.archiveRetainsOwnershipAndPrivileges, true)
  assert.equal(proof.restoreScope, 'public-schema')
  assert.equal(proof.rehearsedOriginalSecurityPreserved, true)
  const drained = timestamp(proof.drainedAt)
  const backup = timestamp(proof.backupCreatedAt)
  const restored = timestamp(proof.restoreVerifiedAt)
  const rehearsed = timestamp(proof.rehearsalVerifiedAt)
  assert.ok(drained <= backup && backup <= restored && restored <= rehearsed && rehearsed <= now)
  assert.ok(now - backup <= 86_400_000, 'release269-backup-stale')
  assert.equal(proof.restoredDataHash, snapshot.dataHash, 'release269-restored-data-mismatch')
  assert.equal(
    proof.restoredPhysicalLedgerHash,
    snapshot.physicalLedgerHash,
    'release269-restored-ledger-mismatch',
  )
  assert.equal(proof.restoredSchemaHash, snapshot.schemaHash, 'release269-restored-schema-mismatch')
  exactHash(proof.rehearsedSchemaHash)
  exactHash(proof.rehearsedNewFunctionPrivilegesHash)
  assert.equal(proof.restoredSequenceStateHash, snapshot.sequenceStateHash)
  assert.equal(proof.rehearsedSequenceStateHash, snapshot.sequenceStateHash)
  assert.equal(
    proof.rehearsedOriginalDataHash,
    snapshot.dataHash,
    'release269-rehearsal-data-mismatch',
  )
  assert.equal(proof.rehearsedActiveLedgerCount, 269)
  assert.equal(proof.rehearsedPhysicalLedgerCount, snapshot.physicalLedgerCount + 2)
  assert.equal(proof.rehearsedAffectedEventRows, 0)
  assert.equal(proof.rehearsedNoPendingReplay, true)
}

export function assertRelease269Drain(snapshot, queues, { target, releaseSha, startedAt, now }) {
  const observed = timestamp(snapshot.observedAt)
  assert.ok(
    observed >= startedAt && observed <= now && now - observed <= 60_000,
    'release269-readback-not-fresh',
  )
  assert.equal(snapshot.otherClientSessions, 0, 'release269-clients-remain')
  assert.equal(snapshot.affectedEventRows, 0, 'release269-event-rewrite-not-admitted')
  assert.equal(
    queues?.schema,
    'torchiko-release269-queue-drain/v1',
    'release269-queue-proof-required',
  )
  assert.equal(queues.target, target)
  assert.equal(queues.releaseSha, releaseSha)
  assert.equal(queues.coverage, 'all-application-queues')
  assert.ok(typeof queues.resourceIdentity === 'string' && queues.resourceIdentity.length > 0)
  assert.equal(
    queues.resourceIdentity,
    snapshot.queueResourceIdentity,
    'release269-queue-resource-mismatch',
  )
  const queueObserved = timestamp(queues.observedAt)
  assert.ok(
    queueObserved >= startedAt - 60_000 && queueObserved <= now && now - queueObserved <= 60_000,
    'release269-queues-not-fresh',
  )
  for (const key of ['waiting', 'active', 'delayed'])
    assert.equal(queues[key], 0, 'release269-queue-not-drained')
}

export function assertRelease269Preserved(before, after) {
  assert.equal(after.activeLedgerCount, 269)
  assert.equal(after.applicabilityDefaultsValid, true, 'release269-applicability-defaults-refused')
  assert.equal(after.applicabilitySchemaValid, true, 'release269-applicability-schema-refused')
  assert.equal(after.eventFunctionPresent, true, 'release269-event-function-missing')
  assert.equal(after.affectedEventRows, 0, 'release269-event-rewrite-not-admitted')
  assert.deepEqual(after.tables, before.tables, 'release269-original-data-changed')
  assert.equal(after.dataHash, before.dataHash, 'release269-original-data-changed')
  assert.equal(after.policyHash, before.policyHash, 'release269-row-security-changed')
  assert.equal(
    after.sequenceStateHash,
    before.sequenceStateHash,
    'release269-sequence-state-changed',
  )
  const beforeSecurity = new Map(before.security.map((row) => [row.identity, row.hash]))
  const afterSecurity = new Map(after.security.map((row) => [row.identity, row.hash]))
  for (const [identity, hash] of beforeSecurity)
    assert.equal(afterSecurity.get(identity), hash, 'release269-ownership-or-acl-changed')
  const addedSecurity = after.security
    .filter((row) => !beforeSecurity.has(row.identity))
    .map((row) => row.identity)
    .sort()
  assert.deepEqual(
    addedSecurity,
    [
      'function:operational_fact_applicability_ids_valid(ids text[])',
      'function:universal_content_event_projection_v1(p_description text, p_starts_at timestamp without time zone, p_ends_at timestamp without time zone)',
    ],
    'release269-unexpected-security-object',
  )
  assert.equal(after.physicalLedgerCount, before.physicalLedgerCount + 2)
  const byId = new Map(after.ledger.map((row) => [row.id, row]))
  for (const row of before.ledger) {
    assert.equal(byId.get(row.id)?.rowHash, row.rowHash, 'release269-physical-ledger-changed')
  }
  const priorIds = new Set(before.ledger.map((row) => row.id))
  const added = after.ledger.filter((row) => !priorIds.has(row.id))
  assert.deepEqual(
    added.map((row) => row.migration_name),
    [
      '20261022001000_deterministic_event_search_projection',
      '20261023001000_add_fact_applicability',
    ],
  )
}

// All adapters are supplied by the fixed CLI, not a hosted request. No fallback
// or automatic retry exists after deploy; unknown outcomes retain their journal.
export async function runRelease269({
  target,
  releaseSha,
  environment,
  proof,
  inspectSource,
  readSnapshot,
  readQueues,
  deploy,
  record = async () => {},
  now = Date.now,
}) {
  const resource = release269Target(environment, target, releaseSha)
  const policy = target === 'staging' ? readStagingApplicationPolicy(environment) : null
  const inspect = async () => {
    const source = await inspectSource()
    assert.equal(source.head, releaseSha)
    assert.equal(source.status, '', 'release269-clean-source-required')
    assert.equal(source.manifest.hash, RELEASE269.manifestHash)
    return source.manifest
  }
  const manifest = await inspect()
  const startedAt = now()
  const before = await readSnapshot()
  const scope = { target, releaseSha, resource }
  assertRelease269Snapshot(before, scope)
  assert.equal(proof.schema, RELEASE269_PROOF_SCHEMA)
  assert.equal(proof.releaseSha, releaseSha)
  assert.equal(proof.target, target)
  assert.equal(proof.databaseResource, resource)
  assert.equal(proof.manifestHash, RELEASE269.manifestHash)
  const state = reconcileRelease269Ledger(before, manifest, proof)
  await record('before', before)
  if (state === 'complete269') {
    if (policy) assertStagingApplicationPolicy(policy, { state: 'complete' })
    assert.equal(before.applicabilitySchemaValid, true)
    assert.equal(before.eventFunctionPresent, true)
    assert.equal(
      before.schemaHash,
      proof.rehearsedSchemaHash,
      'release269-rehearsed-schema-mismatch',
    )
    if (policy) return withStagingApplicationHold(policy, async () => ({ state, changed: false }))
    return { state, changed: false }
  }
  assert.equal(before.affectedEventRows, 0, 'release269-event-rewrite-not-admitted')
  assert.equal(before.applicabilityColumnsPresent, 0, 'release269-unrecorded-schema-change')
  assert.equal(before.eventFunctionPresent, false, 'release269-unrecorded-schema-change')
  assertRelease269Backup(proof, before, { ...scope, now: now() })
  if (target === 'staging') {
    assert.equal(environment.PATHFINDER_STAGING_MIGRATION_APPROVAL, RELEASE269_APPROVAL)
    const admission = assertStagingMigrationAdmission(environment, new Date(now()))
    assert.equal(admission.dataPolicy, 'preserve-existing')
    assert.equal(admission.backupEvidence.ledgerCount, before.activeLedgerCount)
    assert.equal(admission.backupEvidence.archiveSha256, proof.backupSha256)
    assert.equal(admission.backupEvidence.restoreProofSha256, proof.restoreProofSha256)
    assert.equal(admission.backupEvidence.storageResource, proof.backupStorageResource)
    assert.equal(admission.backupEvidence.createdAt, proof.backupCreatedAt)
    assert.equal(admission.backupEvidence.restoreVerifiedAt, proof.restoreVerifiedAt)
    assertStagingApplicationPolicy(policy, {
      state: 'predecessor267',
      dataPolicy: 'preserve-existing',
    })
  }
  const queues = await readQueues({ startedAt })
  // Recheck both source and data after proof acquisition. The second complete
  // readback must be from this invocation and cannot hide a concurrent writer.
  await inspect()
  const immediate = await readSnapshot()
  assertRelease269Snapshot(immediate, scope)
  reconcileRelease269Ledger(immediate, manifest, proof)
  assert.equal(immediate.dataHash, before.dataHash, 'release269-prewrite-data-drift')
  assert.equal(
    immediate.physicalLedgerHash,
    before.physicalLedgerHash,
    'release269-prewrite-ledger-drift',
  )
  assertRelease269Drain(immediate, queues, { ...scope, startedAt, now: now() })
  for (const key of ['schemaHash', 'securityHash', 'policyHash', 'sequenceStateHash']) {
    assert.equal(immediate[key], before[key], 'release269-prewrite-schema-or-security-drift')
  }
  await inspect()
  await record('armed', {
    releaseSha,
    manifestHash: manifest.hash,
    observedAt: immediate.observedAt,
  })
  await deploy()
  const after = await readSnapshot()
  assertRelease269Snapshot(after, scope)
  assert.equal(reconcileRelease269Ledger(after, manifest, proof), 'complete269')
  await record('after', after)
  assert.equal(after.schemaHash, proof.rehearsedSchemaHash, 'release269-rehearsed-schema-mismatch')
  assert.equal(
    after.newFunctionPrivilegesHash,
    proof.rehearsedNewFunctionPrivilegesHash,
    'release269-new-function-privileges-mismatch',
  )
  assertRelease269Preserved(before, after)
  await record('verified', { releaseSha, activeLedgerCount: 269, originalDataHash: after.dataHash })
  const result = { state: 'complete269', changed: true }
  if (policy) return withStagingApplicationHold(policy, async () => result)
  return result
}
