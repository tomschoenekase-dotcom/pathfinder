import { RELEASE269_QUEUE_BASE_NAMES } from './lib/release269-queue-readback.mjs'
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

import {
  runRelease270,
  withRelease270Lock,
  assertRelease270RuntimeTarget,
} from './run-release270-migration.mjs'
import {
  readRelease270Snapshot,
  assertRelease270ConsumerEvidence,
  hashRelease270,
} from './lib/release270-readback.mjs'
function runtime() {
  const h = harness()
  h.proof.rehearsedNewSecurityHash = digest
  h.after.newSecurityHash = digest
  Object.assign(h.environment, {
    RAILWAY_PROJECT_ID: '8621111a-4ac8-4d88-9566-4627c8a02059',
    REDIS_RESOURCE_ID: RELEASE270_STAGING_QUEUE_RESOURCE,
    REDIS_URL: 'redis://redis-5vrb.railway.internal:6379/0',
  })
  const calls = []
  let reads = 0
  const options = {
    ...h,
    now: () => now,
    inspectSource: async () => ({ head: sha, status: '', manifest }),
    readSnapshot: async () => structuredClone(++reads <= 2 ? h.before : h.after),
    withLock: async (action) => {
      calls.push('lock')
      try {
        return await action(123, {
          signal: new AbortController().signal,
          assertHeld: async () => {},
        })
      } finally {
        calls.push('unlock')
      }
    },
    deploy: async () => {
      calls.push('deploy')
    },
    record: async (phase) => {
      calls.push(phase)
    },
  }
  return { h, options, calls }
}
test('runtime stages exact269, verifies full preservation twice and keeps application held', async () => {
  const { options, calls } = runtime()
  assert.deepEqual(await runRelease270(options), {
    changed: true,
    state: 'complete270',
    applicationHeld: true,
  })
  assert.deepEqual(calls, ['lock', 'before', 'armed', 'deploy', 'after', 'unlock', 'verified'])
})
test('production, wrong source, nonheld app and prewrite data drift cannot call deploy', async () => {
  for (const change of [
    (o) => {
      o.environment.RAILWAY_ENVIRONMENT = 'production'
    },
    (o) => {
      o.inspectSource = async () => ({ head: 'b'.repeat(40), status: '', manifest })
    },
    (o) => {
      o.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '0'
    },
    (o) => {
      const read = o.readSnapshot
      let n = 0
      o.readSnapshot = async () => {
        const row = await read()
        if (++n === 2) row.tables[0].hash = '0'.repeat(64)
        return row
      }
    },
  ]) {
    const { options, calls } = runtime()
    change(options)
    await assert.rejects(runRelease270(options))
    assert.ok(!calls.includes('deploy'))
  }
})
test('unknown child or postwrite failure is journaled without retries or raw diagnostics', async () => {
  for (const fail of ['deploy', 'readback']) {
    const { options, calls } = runtime()
    if (fail === 'deploy')
      options.deploy = async () => {
        calls.push('deploy')
        throw new Error('sensitive-driver-details')
      }
    else {
      const read = options.readSnapshot
      let n = 0
      options.readSnapshot = async () => {
        if (++n === 3) throw new Error('sensitive-driver-details')
        return read()
      }
    }
    await assert.rejects(
      runRelease270(options),
      (e) => e.message === 'release270-outcome-unknown-stop-and-reconcile',
    )
    assert.equal(calls.filter((x) => x === 'deploy').length, 1)
    assert.ok(calls.includes('outcome-unknown'))
    assert.equal(calls.at(-1), 'outcome-unknown')
  }
})
test('durable journal failure before arming prevents deploy', async () => {
  const { options, calls } = runtime()
  options.record = async () => {
    throw new Error('disk-full')
  }
  await assert.rejects(runRelease270(options), /disk-full/u)
  assert.ok(!calls.includes('deploy'))
})
test('already complete verifies no pending work without invoking migration child', async () => {
  const { h, options, calls } = runtime()
  options.readSnapshot = async () => h.after
  assert.equal((await runRelease270(options)).changed, false)
  assert.ok(!calls.includes('deploy'))
})
test('advisory lock busy or malformed PID refuses action and transactions always bound', async () => {
  for (const row of [
    { acquired: false, pid: 123 },
    { acquired: true, pid: 0 },
  ]) {
    let executed = false
    const db = {
      $transaction: async (action, config) => {
        assert.equal(config.timeout, 900000)
        return action({
          $queryRawUnsafe: async (sql) => {
            assert.match(sql, /pg_try_advisory_xact_lock\(20261029,270\)/u)
            return [row]
          },
        })
      },
    }
    await assert.rejects(
      withRelease270Lock(db, () => {
        executed = true
      }),
    )
    assert.equal(executed, false)
  }
})
const consumerEvidence = () => ({
  schema: 'torchiko-release270-consumer-inventory/v1',
  releaseSha: sha,
  resource: RELEASE270_STAGING_QUEUE_RESOURCE,
  coverage: 'all-staging-deployed-consumers',
  unexpectedConsumers: 0,
  consumersHeld: true,
  observedAt: iso(-1000),
  inventory: [
    {
      serviceId: 'fictional-worker',
      consumersHeld: true,
      workerFlags: { ENABLE_FICTIONAL_WORKER: 'false' },
    },
  ],
})
const consumerSeal = (e) => {
  const { observedAt, ...value } = e
  return hashRelease270(value)
}
test('consumer evidence seals inventory/flags and requires freshness, coverage, hold and exact staging resource', () => {
  const evidence = consumerEvidence(),
    scope = { releaseSha: sha, expectedHash: consumerSeal(evidence), now }
  assert.equal(assertRelease270ConsumerEvidence(evidence, scope).unexpectedConsumers, 0)
  for (const change of [
    { observedAt: iso(-61000) },
    { consumersHeld: false },
    { resource: 'other' },
    { coverage: 'partial' },
    { unexpectedConsumers: 1 },
  ])
    assert.throws(() => assertRelease270ConsumerEvidence({ ...evidence, ...change }, scope))
  const changed = structuredClone(evidence)
  changed.inventory[0].workerFlags.ENABLE_FICTIONAL_WORKER = 'true'
  assert.throws(() => assertRelease270ConsumerEvidence(changed, scope))
})
test('readback uses read-only snapshots, hashes applicability columns, preserves microsecond ledger text and excludes only own lock PID', async () => {
  const evidence = consumerEvidence(),
    statements = []
  const ledger = {
    id: 'fictional-ledger',
    migration_name: 'fictional-migration',
    started_at: '2026-10-29T00:00:00.123456+00:00',
    finished_at: '2026-10-29T00:00:00.234567+00:00',
    logs: '',
    applied_steps_count: 1,
  }
  const query = async (sql) => {
    statements.push(sql)
    if (sql.includes('pg_stat_activity')) {
      assert.match(sql, /AND pid<>123 /u)
      return []
    }
    if (sql.includes('to_jsonb(m) AS row')) return [{ row: ledger, rowHash: digest }]
    if (sql.includes('FROM pg_tables'))
      return [{ tablename: '_prisma_migrations' }, { tablename: 'operational_fact_content' }]
    if (sql.includes('information_schema.columns'))
      return [
        { table_name: 'operational_fact_content', column_name: 'id' },
        { table_name: 'operational_fact_content', column_name: 'applicability_scope' },
      ]
    if (sql.startsWith('SELECT count(*)::text')) {
      assert.match(sql, /"applicability_scope"/u)
      return [{ count: '0', hash: digest }]
    }
    return []
  }
  const db = {
    $transaction: async (action, config) => {
      assert.equal(config.isolationLevel, 'RepeatableRead')
      return action({
        $executeRawUnsafe: async (sql) => {
          statements.push(sql)
        },
        $queryRawUnsafe: query,
      })
    },
  }
  const q = {
    schema: 'torchiko-release269-queue-preservation/v2',
    approval: 'torchiko-preserve-dormant-queues-20261026',
    transport: 'EVAL_RO-and-CLIENT-LIST',
    preserved: true,
    workers: 0,
    active: 0,
    prioritized: 0,
    waitingChildren: 0,
    waiting: 0,
    delayed: 0,
    failed: 0,
    registry: RELEASE269_QUEUE_BASE_NAMES.map((name) => `staging--${name}`),
    countsSha256: digest,
    jobsSha256: digest,
    canonicalSha256: digest,
    target: 'staging',
    releaseSha: sha,
    resourceIdentity: RELEASE270_STAGING_QUEUE_RESOURCE,
    coverage: 'all-application-queues',
    firstObservedAt: iso(-31000),
    observedAt: iso(-1000),
  }
  const snapshot = await readRelease270Snapshot({
    database: db,
    releaseSha: sha,
    databaseResource: EXPECTED.databaseResourceId,
    lockPid: 123,
    readQueues: async () => {
      assert.ok(statements.some((sql) => sql.includes('pg_stat_activity')))
      return q
    },
    readConsumers: async () => evidence,
    trustedConsumerInventoryHash: consumerSeal(evidence),
    now: () => now,
  })
  assert.equal(snapshot.ledger[0].started_at, ledger.started_at)
  assert.equal(snapshot.ledger[0].finished_at, ledger.finished_at)
  assert.deepEqual(snapshot.tables[0].columns, ['id', 'applicability_scope'])
  assert.equal(snapshot.observedAt, iso(-31000))
  for (const sql of statements) assert.match(sql, /^(SELECT|SET TRANSACTION READ ONLY|SET LOCAL)/u)
})
test('cutoff digest ignores only observedAt and retains all authorization and preservation fields', () => {
  const h = harness()
  const changed = structuredClone(h.before)
  changed.observedAt = iso(-200)
  assert.equal(release270CutoffHash(changed), release270CutoffHash(h.before))
  for (const field of [
    'releaseSha',
    'databaseResource',
    'queueHash',
    'consumerInventoryHash',
    'existingSecurityHash',
  ]) {
    const copy = structuredClone(changed)
    copy[field] = 'different'
    assert.notEqual(release270CutoffHash(copy), release270CutoffHash(h.before))
  }
})

test('outer lock completion failure cannot record verified after migration', async () => {
  const { options, calls } = runtime()
  options.withLock = async (action) => {
    await action(123, { signal: new AbortController().signal, assertHeld: async () => {} })
    throw new Error('lock-commit-failed')
  }
  await assert.rejects(runRelease270(options), /outcome-unknown/u)
  assert.ok(calls.includes('outcome-unknown'))
  assert.ok(!calls.includes('verified'))
})
test('lost lock probe before deploy prevents child invocation', async () => {
  const { options, calls } = runtime()
  options.withLock = async (action) =>
    action(123, {
      signal: new AbortController().signal,
      assertHeld: async () => {
        throw new Error('lost')
      },
    })
  await assert.rejects(runRelease270(options), /lost/u)
  assert.ok(!calls.includes('deploy'))
})

test('unreviewed new object grants cannot pass initial post-migration verification', async () => {
  const { options, calls } = runtime()
  const read = options.readSnapshot
  let n = 0
  options.readSnapshot = async () => {
    const snapshot = await read()
    if (++n === 3) snapshot.newSecurityHash = '0'.repeat(64)
    return snapshot
  }
  await assert.rejects(runRelease270(options), /outcome-unknown/u)
  assert.ok(!calls.includes('verified'))
})

test('lock guardian aborts the in-flight action when the database lock is lost', async () => {
  let acquired = false,
    aborted = false
  const database = {
    $transaction: async (action) =>
      action({
        $queryRawUnsafe: async (sql) => {
          if (sql.includes('pg_try_advisory_xact_lock')) {
            acquired = true
            return [{ pid: 123, acquired: true }]
          }
          return [{ held: false }]
        },
      }),
  }
  await assert.rejects(
    withRelease270Lock(database, async (pid, guard) => {
      assert.equal(acquired, true)
      await new Promise((resolve) =>
        guard.signal.addEventListener(
          'abort',
          () => {
            aborted = true
            resolve()
          },
          { once: true },
        ),
      )
    }),
    /lock-lost/u,
  )
  assert.equal(aborted, true)
})
