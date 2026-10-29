// Pure staging-only evidence admission. No connections, flags, subprocesses or
// migration execution. A caller must separately maintain the application hold,
// acquire the reviewed migration lock, collect fresh read-only snapshots and
// journal unknown outcomes before this can be used by an operational runner.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  EXPECTED,
  assertStagingSchemaReadAdmission,
  assertStagingApplicationPolicy,
  readStagingApplicationPolicy,
} from '../run-staging-migration-predeploy.mjs'
import { assertStagingMigrationAdmission } from './staging-migration-admission.mjs'
import {
  assertRelease270Ledger,
  RELEASE270,
  RELEASE270_SUFFIX,
} from './release270-migration-contract.mjs'
import { assertRelease270Catalog } from './release270-catalog-contract.mjs'

export const RELEASE270_STAGING_QUEUE_RESOURCE = 'd53ab235-d403-4d7d-b525-3ace0ef07b92'
export const RELEASE270_STAGING_APPROVAL = 'torchiko-staging-269-to-270-reviewed-v1'
export const RELEASE270_STAGING_PROOF_SCHEMA = 'torchiko-release270-staging-evidence/v1'
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
// Ignore only the explicitly fresh observation timestamp. All source, resource,
// catalog, ledger, data, queue, consumer and security fields remain sealed.
export const release270CutoffHash = ({ observedAt, ...evidence }) => hash(evidence)
const exactHash = (value) =>
  assert.match(value ?? '', /^[a-f0-9]{64}$/u, 'release270-proof-hash-required')
const fresh = (value, now, age) => {
  assert.equal(typeof value, 'string')
  const date = new Date(value)
  assert.equal(date.toISOString(), value, 'release270-canonical-time-required')
  assert.ok(
    date.valueOf() <= now && now - date.valueOf() <= age,
    'release270-stale-or-future-proof',
  )
}

// The trusted digest is supplied by the separately reviewed external collector;
// a claimed zero active-job count alone cannot establish consumer exclusion.
function assertConsumerInventory(snapshot, proof) {
  assert.equal(
    snapshot.queueResource,
    RELEASE270_STAGING_QUEUE_RESOURCE,
    'release270-staging-queue-resource',
  )
  assert.equal(
    proof.queueResource,
    RELEASE270_STAGING_QUEUE_RESOURCE,
    'release270-proof-queue-resource',
  )
  exactHash(proof.trustedConsumerInventoryHash)
  exactHash(snapshot.consumerInventoryHash)
  assert.equal(
    snapshot.consumerInventoryHash,
    proof.trustedConsumerInventoryHash,
    'release270-consumer-inventory-mismatch',
  )
  assert.equal(snapshot.unexpectedConsumers, 0, 'release270-unexpected-consumers')
  for (const field of [
    'queueHash',
    'workerFlagsHash',
    'sequenceStateHash',
    'policyHash',
    'existingSecurityHash',
  ])
    exactHash(snapshot[field])
}

export function assertRelease270StagingAdmission({
  environment,
  releaseSha,
  sourceHead,
  sourceStatus,
  approval,
  proof,
  manifest,
  before,
  now = Date.now(),
}) {
  assert.match(releaseSha ?? '', /^[a-f0-9]{40}$/u, 'release270-full-source-sha-required')
  assert.equal(sourceHead, releaseSha, 'release270-source-head-mismatch')
  assert.equal(sourceStatus, '', 'release270-dirty-source')
  assert.equal(assertStagingSchemaReadAdmission(environment).releaseSha, releaseSha)
  assert.equal(proof?.schema, RELEASE270_STAGING_PROOF_SCHEMA)
  assert.equal(proof.releaseSha, releaseSha)
  assert.equal(proof.referenceReleaseSha, releaseSha, 'release270-reference-source-mismatch')
  assert.equal(proof.databaseResource, EXPECTED.databaseResourceId)
  assert.equal(proof.manifestHash, RELEASE270.manifestHash)
  assert.equal(proof.independentRestoreVerified, true, 'release270-independent-restore-required')
  exactHash(proof.backupSha256)
  exactHash(proof.restoreProofSha256)
  exactHash(proof.referenceHash)
  assertRelease270Catalog(proof.reference, proof)
  fresh(proof.createdAt, now, 86_400_000)
  assert.equal(before.releaseSha, releaseSha)
  assert.equal(before.databaseResource, EXPECTED.databaseResourceId)
  fresh(before.observedAt, now, 60_000)
  assert.equal(before.blockingClientSessions, 0, 'release270-active-clients')
  assert.equal(before.activeOrTransactionalClientSessions, 0, 'release270-active-transactions')
  assert.equal(before.activeQueueJobs, 0, 'release270-active-queue-jobs')
  assertConsumerInventory(before, proof)
  exactHash(before.queueHash)
  exactHash(before.workerFlagsHash)
  assert.equal(before.workerFlagsHash, proof.workerFlagsHash, 'release270-worker-policy-drift')
  const state = assertRelease270Ledger(before.ledger, manifest, proof)
  assert.ok(['predecessor269', 'complete270'].includes(state.state), 'release270-staging-269-only')
  assert.equal(before.publicTableCount, state.state === 'predecessor269' ? 297 : 299)
  const policy = readStagingApplicationPolicy(environment)
  if (state.state === 'predecessor269') {
    assert.equal(
      approval,
      RELEASE270_STAGING_APPROVAL,
      'release270-explicit-staging-approval-required',
    )
    // Do not replace opt-in or hold variables: existing gates remain mandatory.
    const admitted = assertStagingMigrationAdmission(environment, new Date(now))
    assert.equal(admitted.dataPolicy, 'preserve-existing')
    assert.equal(admitted.backupEvidence.ledgerCount, 269)
    assert.equal(admitted.backupEvidence.archiveSha256, proof.backupSha256)
    assert.equal(admitted.backupEvidence.restoreProofSha256, proof.restoreProofSha256)
    assertStagingApplicationPolicy(policy, { state: 'pending', dataPolicy: 'preserve-existing' })
    assert.equal(
      proof.beforeSnapshotHash,
      release270CutoffHash(before),
      'release270-backup-cutoff-mismatch',
    )
    assert.deepEqual(state.pending, [RELEASE270_SUFFIX[2].name])
  } else {
    assertStagingApplicationPolicy(policy, { state: 'complete', dataPolicy: 'preserve-existing' })
    assertRelease270Catalog(before.catalog, proof)
  }
  return { state: state.state, pending: state.pending, hostedApplicationAuthorized: false }
}

export function assertRelease270StagingPreserved(
  before,
  after,
  manifest,
  proof,
  { now = Date.now() } = {},
) {
  fresh(before.observedAt, now, 900_000)
  fresh(after.observedAt, now, 60_000)
  assert.ok(
    Date.parse(after.observedAt) >= Date.parse(before.observedAt),
    'release270-snapshot-order',
  )
  assertConsumerInventory(before, proof)
  assertConsumerInventory(after, proof)
  assert.equal(after.releaseSha, before.releaseSha)
  assert.equal(after.databaseResource, before.databaseResource)
  assert.equal(assertRelease270Ledger(before.ledger, manifest, proof).state, 'predecessor269')
  assert.equal(assertRelease270Ledger(after.ledger, manifest, proof).state, 'complete270')
  assert.deepEqual(after.ledger.slice(0, 269), before.ledger, 'release270-physical-ledger-mutated')
  assert.equal(after.publicTableCount, 299)
  assert.ok(Array.isArray(before.tables) && before.tables.length === 296)
  assert.ok(Array.isArray(after.tables) && after.tables.length === 298)
  for (const snapshot of [before, after]) {
    assert.equal(new Set(snapshot.tables.map((row) => row.name)).size, snapshot.tables.length)
    for (const row of snapshot.tables) {
      assert.match(row.count ?? '', /^\d+$/u)
      exactHash(row.hash)
    }
  }
  const newNames = ['embedding_venue_refresh_records', 'embedding_venue_refreshes']
  assert.deepEqual(
    after.tables.filter((row) => !newNames.includes(row.name)),
    before.tables,
    'release270-existing-data-mutated',
  )
  for (const name of newNames) {
    const row = after.tables.find((table) => table.name === name)
    assert.equal(row?.count, '0', 'release270-new-receipts-must-start-empty')
  }
  for (const field of [
    'queueResource',
    'queueHash',
    'workerFlagsHash',
    'sequenceStateHash',
    'policyHash',
    'existingSecurityHash',
  ]) {
    if (field !== 'queueResource') exactHash(before[field])
    assert.equal(after[field], before[field], `release270-${field}-changed`)
  }
  assert.equal(after.blockingClientSessions, 0)
  assert.equal(after.activeOrTransactionalClientSessions, 0)
  assert.equal(after.activeQueueJobs, 0)
  assertRelease270Catalog(after.catalog, proof)
  return { state: 'complete270', hostedApplicationAuthorized: false }
}
