import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  RELEASE270_CATALOG_SCHEMA,
  assertRelease270Catalog,
  assertRelease270CatalogShape,
  release270CatalogHash,
  readRelease270Catalog,
} from './lib/release270-catalog-contract.mjs'

// Synthetic contract fixture, not PostgreSQL replay evidence or an approved seal.
const functions = []
for (const migration of [
  '20261022001000_deterministic_event_search_projection',
  '20261023001000_add_fact_applicability',
]) {
  const sql = (
    await readFile(
      new URL(`../packages/db/prisma/migrations/${migration}/migration.sql`, import.meta.url),
      'utf8',
    )
  ).replace(/\r\n/gu, '\n')
  for (const match of sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION ([a-z_0-9]+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
  )) {
    functions.push({
      proname: match[1],
      arguments: '',
      source: match[2],
      security_definer: false,
      definition: match[0],
    })
  }
}
const fixture = () => {
  const tables = [
    'embedding_venue_refreshes',
    'embedding_venue_refresh_records',
    ...Array.from({ length: 297 }, (_, i) => `fictional_table_${i}`),
  ]
  const constraints = Object.entries({
    embedding_venue_refreshes: ['pkey', 'max_records_check', 'tenant_id_fkey', 'venue_id_fkey'],
    embedding_venue_refresh_records: ['pkey', 'ordinal_check', 'entity_type_check', 'scope_fkey'],
    operational_fact: ['applicability_shape_check'],
  }).flatMap(([table, names]) =>
    names.map((name) => ({
      relname: table === 'operational_fact' ? 'operational_fact_content' : table,
      conname: `${table}_${name}`,
      contype: name.endsWith('fkey') ? 'f' : name === 'pkey' ? 'p' : 'c',
      convalidated: true,
      delete_action: name.endsWith('fkey') ? 'r' : ' ',
      update_action: name.endsWith('fkey') ? 'c' : ' ',
      definition: `fictional exact definition ${table}_${name}`,
    })),
  )
  return {
    schema: RELEASE270_CATALOG_SCHEMA,
    tables: tables.map((tablename) => ({ tablename })),
    columns: [
      'applicability_scope',
      'applicability_subject_module_ids',
      'applicability_place_ids',
    ].map((column_name, index) => ({
      table_name: 'operational_fact_content',
      column_name,
      udt_name: index === 0 ? 'text' : '_text',
      formatted_type: index === 0 ? 'text' : 'text[]',
      atttypmod: -1,
      is_nullable: index === 0 ? 'YES' : 'NO',
      column_default: index === 0 ? null : "'{}'::text[]",
    })),
    enums: Object.entries({
      EmbeddingVenueRefreshStatus: ['QUEUED', 'RUNNING', 'COMPLETE', 'STOPPED', 'OUTCOME_UNKNOWN'],
      EmbeddingVenueRefreshRecordStatus: [
        'PENDING',
        'RUNNING',
        'COMPLETE',
        'FAILED',
        'OUTCOME_UNKNOWN',
      ],
    }).flatMap(([typname, labels]) =>
      labels.map((enumlabel, index) => ({ typname, enumlabel, enumsortorder: index + 1 })),
    ),
    constraints,
    indexes: [
      'embedding_venue_refreshes_operation_key_key',
      'embedding_venue_refreshes_tenant_id_venue_id_id_key',
      'embedding_venue_refreshes_tenant_id_venue_id_created_at_idx',
      'embedding_venue_refreshes_active_venue_key',
      'embedding_venue_refresh_records_refresh_id_ordinal_key',
      'embedding_venue_refresh_records_refresh_id_entity_type_entity_i',
      'embedding_venue_refresh_records_tenant_id_venue_id_refresh_id_i',
    ].map((relname) => ({
      relname,
      indisvalid: true,
      definition: `fictional exact index ${relname}`,
    })),
    functions: structuredClone(functions),
    triggers: [
      {
        relname: 'fictional_table_1',
        tgname: 'immutable_guard',
        enabled: 'O',
        definition: 'fictional append-only guard',
      },
    ],
  }
}

import { createHash } from 'node:crypto'
import { readMigrationManifest, EXPECTED } from './run-staging-migration-predeploy.mjs'
import { RELEASE270 } from './lib/release270-migration-contract.mjs'
import {
  assertRelease270StagingAdmission,
  release270CutoffHash,
  assertRelease270StagingPreserved,
  RELEASE270_STAGING_APPROVAL,
  RELEASE270_STAGING_QUEUE_RESOURCE,
  RELEASE270_STAGING_PROOF_SCHEMA,
} from './lib/release270-staging-admission.mjs'
const manifest = await readMigrationManifest(
  fileURLToPath(new URL('../packages/db/prisma', import.meta.url)),
)
const sha = 'a'.repeat(40),
  now = Date.parse('2026-10-29T03:00:00.000Z')
const iso = (delta) => new Date(now + delta).toISOString()
const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const digest = 'b'.repeat(64)
function harness() {
  const reference = fixture()
  const ledger = manifest.names.map((migration_name, i) => ({
    id: `fictional-${i}`,
    migration_name,
    checksum: manifest.checksums.get(migration_name),
    started_at: iso(-20000),
    finished_at: iso(-10000),
    rolled_back_at: null,
    logs: '',
    applied_steps_count: 1,
  }))
  const before = {
    postgresMajor: 17,
    releaseSha: sha,
    databaseResource: EXPECTED.databaseResourceId,
    observedAt: iso(-1000),
    blockingClientSessions: 0,
    activeOrTransactionalClientSessions: 0,
    activeQueueJobs: 0,
    queueResource: RELEASE270_STAGING_QUEUE_RESOURCE,
    consumerInventoryHash: digest,
    unexpectedConsumers: 0,
    queueHash: digest,
    workerFlagsHash: digest,
    ledger: ledger.slice(0, 269),
    publicTableCount: 297,
    tables: Array.from({ length: 296 }, (_, i) => ({
      name: `fictional_table_${i}`,
      count: '0',
      hash: digest,
    })),
    sequenceStateHash: digest,
    policyHash: digest,
    existingSecurityHash: digest,
  }
  const proof = {
    referencePostgresMajor: 17,
    schema: RELEASE270_STAGING_PROOF_SCHEMA,
    releaseSha: sha,
    referenceReleaseSha: sha,
    databaseResource: EXPECTED.databaseResourceId,
    manifestHash: RELEASE270.manifestHash,
    independentRestoreVerified: true,
    backupSha256: digest,
    restoreProofSha256: digest,
    reference,
    referenceHash: release270CatalogHash(reference),
    createdAt: iso(-10000),
    queueResource: before.queueResource,
    trustedConsumerInventoryHash: digest,
    workerFlagsHash: digest,
    beforeSnapshotHash: release270CutoffHash(before),
  }
  const environment = {
    RAILWAY_ENVIRONMENT: 'staging',
    RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
    RAILWAY_SERVICE_ID: EXPECTED.serviceId,
    DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
    RAILWAY_GIT_COMMIT_SHA: sha,
    DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
    DIRECT_DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
    PATHFINDER_ALLOW_STAGING_MIGRATIONS: '1',
    PATHFINDER_STAGING_MIGRATION_ONLY_HOLD: '1',
    PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'preserve-existing',
    PATHFINDER_STAGING_SPEND_CEILING_USD: '10',
    PATHFINDER_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'database.railway.internal',
    PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'database.railway.internal',
    PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'pathfinder_staging',
    PATHFINDER_STAGING_BACKUP_RELEASE_SHA: sha,
    PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE: 'fictional-independent-backup',
    PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE: 'fictional-independent-backup',
    PATHFINDER_STAGING_BACKUP_LEDGER_COUNT: '269',
    PATHFINDER_STAGING_BACKUP_CREATED_AT: iso(-30000),
    PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT: iso(-20000),
    PATHFINDER_STAGING_BACKUP_SHA256: digest,
    PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256: digest,
  }
  const after = {
    ...structuredClone(before),
    observedAt: iso(-500),
    ledger: structuredClone(ledger),
    publicTableCount: 299,
    catalog: reference,
    tables: [
      ...structuredClone(before.tables),
      ...['embedding_venue_refresh_records', 'embedding_venue_refreshes'].map((name) => ({
        name,
        count: '0',
        hash: digest,
      })),
    ],
  }
  return {
    environment,
    releaseSha: sha,
    sourceHead: sha,
    sourceStatus: '',
    approval: RELEASE270_STAGING_APPROVAL,
    proof,
    manifest,
    before,
    after,
    now,
  }
}
test('staging269 admits only the one pinned suffix without altering environment', () => {
  const h = harness(),
    env = structuredClone(h.environment)
  assert.deepEqual(assertRelease270StagingAdmission(h), {
    state: 'predecessor269',
    pending: [manifest.names[269]],
    hostedApplicationAuthorized: false,
  })
  assert.deepEqual(h.environment, env)
  assert.equal(
    assertRelease270StagingPreserved(h.before, h.after, manifest, h.proof, { now }).state,
    'complete270',
  )
})
test('no one-time approval bypasses existing opt-in or held-application policy', () => {
  for (const [key, value] of [
    ['PATHFINDER_ALLOW_STAGING_MIGRATIONS', '0'],
    ['PATHFINDER_STAGING_MIGRATION_ONLY_HOLD', '0'],
    ['RAILWAY_ENVIRONMENT', 'production'],
    ['RAILWAY_SERVICE_ID', 'other'],
    ['PATHFINDER_CONFIRM_STAGING_DATA_POLICY', 'synthetic-only'],
  ]) {
    const h = harness()
    h.environment[key] = value
    assert.throws(() => assertRelease270StagingAdmission(h))
  }
})
test('wrong source, reference, backup, cutoff, freshness and unreviewed boundary fail closed', () => {
  for (const mutate of [
    (h) => (h.sourceHead = 'c'.repeat(40)),
    (h) => (h.sourceStatus = ' M file'),
    (h) => (h.approval = 'old-approval'),
    (h) => (h.proof.referenceReleaseSha = 'c'.repeat(40)),
    (h) => (h.proof.independentRestoreVerified = false),
    (h) => (h.proof.beforeSnapshotHash = '0'.repeat(64)),
    (h) => (h.before.observedAt = iso(-61000)),
    (h) => (h.before.observedAt = iso(1)),
    (h) => (h.before.ledger = h.before.ledger.slice(0, 267)),
    (h) => (h.before.activeQueueJobs = 1),
    (h) => (h.before.blockingClientSessions = 1),
  ]) {
    const h = harness()
    mutate(h)
    assert.throws(() => assertRelease270StagingAdmission(h))
  }
})
test('reference and target PostgreSQL major must match before and after migration', () => {
  for (const major of [undefined, 16, 18, '17']) {
    const h = harness()
    h.proof.referencePostgresMajor = major
    assert.throws(() => assertRelease270StagingAdmission(h), /postgres-major/)
  }
  const h = harness()
  h.after.postgresMajor = 16
  assert.throws(
    () => assertRelease270StagingPreserved(h.before, h.after, manifest, h.proof, { now }),
    /postgres-major-changed/,
  )
})

test('physical history, old data, queues, flags and security must survive unchanged', () => {
  for (const mutate of [
    (a) => (a.ledger[0].id = 'changed'),
    (a) => (a.tables[0].hash = '0'.repeat(64)),
    (a) => (a.queueHash = '0'.repeat(64)),
    (a) => (a.workerFlagsHash = '0'.repeat(64)),
    (a) => (a.existingSecurityHash = '0'.repeat(64)),
    (a) => (a.tables.at(-1).count = '1'),
  ]) {
    const h = harness()
    mutate(h.after)
    assert.throws(() =>
      assertRelease270StagingPreserved(h.before, h.after, manifest, h.proof, { now }),
    )
  }
})
test('complete270 rerun requires validated catalog and closed opt-in or held application', () => {
  const h = harness()
  h.before = h.after
  h.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '0'
  h.environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '0'
  assert.equal(assertRelease270StagingAdmission(h).state, 'complete270')
  h.environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '1'
  assert.throws(() => assertRelease270StagingAdmission(h))
})

test('untrusted queue or consumer identities are refused even with zero active jobs', () => {
  for (const mutate of [
    (h) => {
      h.before.queueResource = 'untrusted'
      h.proof.queueResource = 'untrusted'
    },
    (h) => {
      delete h.proof.trustedConsumerInventoryHash
    },
    (h) => {
      h.before.consumerInventoryHash = '0'.repeat(64)
    },
    (h) => {
      h.before.unexpectedConsumers = 1
    },
    (h) => {
      delete h.before.unexpectedConsumers
    },
  ]) {
    const h = harness()
    mutate(h)
    assert.throws(() => assertRelease270StagingAdmission(h))
  }
})
test('preservation requires fresh ordered snapshots and exact security/sequence hash syntax', () => {
  for (const mutate of [
    (h) => {
      h.after.observedAt = iso(-61000)
    },
    (h) => {
      h.after.observedAt = iso(1)
    },
    (h) => {
      h.after.observedAt = iso(-2000)
    },
    (h) => {
      h.before.observedAt = iso(-900001)
    },
    (h) => {
      h.before.sequenceStateHash = h.after.sequenceStateHash = 'same-invalid-hash'
    },
    (h) => {
      h.before.existingSecurityHash = h.after.existingSecurityHash = true
    },
    (h) => {
      h.after.unexpectedConsumers = 1
    },
    (h) => {
      h.after.consumerInventoryHash = '0'.repeat(64)
    },
  ]) {
    const h = harness()
    mutate(h)
    assert.throws(() =>
      assertRelease270StagingPreserved(h.before, h.after, manifest, h.proof, { now }),
    )
  }
})
