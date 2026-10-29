import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import { RELEASE270 } from './lib/release270-migration-contract.mjs'
import {
  RELEASE270_CATALOG_SCHEMA,
  release270CatalogHash,
} from './lib/release270-catalog-contract.mjs'
import { STAGING_RELEASE_TARGET as target } from './lib/staging-release-admission.mjs'
import {
  APPLICATION_SEAL_SCHEMA,
  APPLICATION_RECEIPT_SCHEMA,
  APPLICATION_SOURCE_FILES,
  applicationHash,
  applicationBytesHash,
  verifyRelease270ApplicationArtifacts,
  assertRelease270ApplicationTarget,
  assertRelease270ApplicationReceipt,
  assertRelease270ApplicationSnapshot,
  readRelease270ApplicationSnapshot,
  admitRelease270Application,
} from './lib/release270-application-admission.mjs'
import { main } from './run-release270-staging-predeploy.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = await readMigrationManifest(`${root}/packages/db/prisma`)
const sha = 'a'.repeat(40),
  digest = 'b'.repeat(64),
  now = Date.parse('2026-10-29T10:00:00.000Z')
const iso = (n = 0) => new Date(now + n).toISOString()
const functions = []
for (const migration of [
  '20261022001000_deterministic_event_search_projection',
  '20261023001000_add_fact_applicability',
]) {
  const sql = (
    await readFile(`${root}/packages/db/prisma/migrations/${migration}/migration.sql`, 'utf8')
  ).replace(/\r\n/gu, '\n')
  for (const match of sql.matchAll(
    /CREATE (?:OR REPLACE )?FUNCTION ([a-z_0-9]+)\([\s\S]*?AS \$\$([\s\S]*?)\$\$;/gu,
  ))
    functions.push({
      proname: match[1],
      arguments: '',
      source: match[2],
      security_definer: false,
      definition: match[0],
    })
}
// Synthetic unit fixture only; never an independently reviewed runtime reference.
function catalogFixture() {
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
      definition: `fictional ${table}_${name}`,
    })),
  )
  return {
    schema: RELEASE270_CATALOG_SCHEMA,
    tables: [
      'embedding_venue_refreshes',
      'embedding_venue_refresh_records',
      ...Array.from({ length: 297 }, (_, i) => `fictional_${i}`),
    ].map((tablename) => ({ tablename })),
    columns: [
      'applicability_scope',
      'applicability_subject_module_ids',
      'applicability_place_ids',
    ].map((column_name, i) => ({
      table_name: 'operational_fact_content',
      column_name,
      udt_name: i ? '_text' : 'text',
      formatted_type: i ? 'text[]' : 'text',
      atttypmod: -1,
      is_nullable: i ? 'NO' : 'YES',
      column_default: i ? "'{}'::text[]" : null,
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
      labels.map((enumlabel, i) => ({ typname, enumlabel, enumsortorder: i + 1 })),
    ),
    constraints,
    functions: structuredClone(functions),
    triggers: [],
    indexes: [
      'embedding_venue_refreshes_operation_key_key',
      'embedding_venue_refreshes_tenant_id_venue_id_id_key',
      'embedding_venue_refreshes_tenant_id_venue_id_created_at_idx',
      'embedding_venue_refreshes_active_venue_key',
      'embedding_venue_refresh_records_refresh_id_ordinal_key',
      'embedding_venue_refresh_records_refresh_id_entity_type_entity_i',
      'embedding_venue_refresh_records_tenant_id_venue_id_refresh_id_i',
    ].map((relname) => ({ relname, indisvalid: true, definition: `fictional ${relname}` })),
  }
}
function fixture() {
  const reference = catalogFixture()
  const ledger = manifest.names.map((migration_name, i) => ({
    id: `fictional-${i}`,
    migration_name,
    checksum: manifest.checksums.get(migration_name),
    started_at: iso(-30000),
    finished_at: iso(-20000),
    rolled_back_at: null,
    logs: '',
    applied_steps_count: 1,
    rowHash: digest,
  }))
  const snapshot = {
    observedAt: iso(-1),
    databaseName: 'pathfinder_staging',
    postgresMajor: 17,
    ledger,
    catalog: structuredClone(reference),
    newSecurityHash: digest,
    existingSecurityHash: digest,
    policyHash: digest,
  }
  const receipt = {
    schema: APPLICATION_RECEIPT_SCHEMA,
    environment: 'staging',
    projectId: target.projectId,
    environmentId: target.environmentId,
    resources: { ...target.resources },
    databaseHost: 'database.railway.internal',
    databasePort: '5432',
    releaseSha: sha,
    referenceReleaseSha: sha,
    manifestHash: RELEASE270.manifestHash,
    catalogHash: release270CatalogHash(reference),
    postgresMajor: 17,
    phase: 'verified',
    state: 'complete270',
    applicationReleaseApproved: true,
    independentRestoreVerified: true,
    migrationJournalSha256: digest,
    backupSha256: digest,
    restoreProofSha256: digest,
    independentReviewSha256: digest,
    physicalLedgerHash: applicationHash(ledger),
    newSecurityHash: digest,
    existingSecurityHash: digest,
    policyHash: digest,
    reconciledZeroStepRows: [],
    completedAt: iso(-10000),
    approvedAt: iso(-5000),
    expiresAt: iso(600000),
  }
  const sourceFiles = Object.fromEntries(
    APPLICATION_SOURCE_FILES.map((name) => [name, Buffer.from(`fictional source ${name}`)]),
  )
  const receiptBytes = Buffer.from(JSON.stringify(receipt)),
    referenceBytes = Buffer.from(JSON.stringify(reference))
  const seal = {
    schema: APPLICATION_SEAL_SCHEMA,
    releaseSha: sha,
    manifestHash: RELEASE270.manifestHash,
    trackedSourceArchiveSha256: digest,
    files: Object.fromEntries(
      APPLICATION_SOURCE_FILES.map((name) => [name, applicationBytesHash(sourceFiles[name])]),
    ),
    receiptSha256: applicationBytesHash(receiptBytes),
    referenceSha256: applicationBytesHash(referenceBytes),
  }
  const sealBytes = Buffer.from(JSON.stringify(seal))
  const input = {
    sealBytes,
    receiptBytes,
    referenceBytes,
    expectedSealSha256: applicationBytesHash(sealBytes),
    sourceFiles,
    manifest,
  }
  const artifacts = verifyRelease270ApplicationArtifacts(input)
  const environment = {
    RAILWAY_ENVIRONMENT: 'staging',
    RAILWAY_PROJECT_ID: target.projectId,
    RAILWAY_ENVIRONMENT_ID: target.environmentId,
    RAILWAY_SERVICE_ID: target.services['staging-web'],
    RAILWAY_GIT_COMMIT_SHA: sha,
    DATABASE_RESOURCE_ID: target.resources.database,
    REDIS_RESOURCE_ID: target.resources.redis,
    STORAGE_RESOURCE_ID: target.resources.storage,
    PATHFINDER_ALLOW_STAGING_MIGRATIONS: '0',
    PATHFINDER_STAGING_MIGRATION_ONLY_HOLD: '0',
    DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
    DIRECT_DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
  }
  return { input, artifacts, environment, snapshot }
}

test('sealed complete270 admits each known staging service without migration authority', async () => {
  for (const id of Object.values(target.services)) {
    const f = fixture()
    f.environment.RAILWAY_SERVICE_ID = id
    const result = await admitRelease270Application({
      ...f,
      readSnapshot: async () => f.snapshot,
      now: () => now,
    })
    assert.equal(result.state, 'complete270')
    assert.equal(result.migrationAuthorityGranted, false)
  }
})
test('wrong image/receipt/reference/source bytes and source inventory refuse', () => {
  for (const change of [
    (f) => (f.input.expectedSealSha256 = 'c'.repeat(64)),
    (f) => (f.input.receiptBytes = Buffer.from('{}')),
    (f) => (f.input.referenceBytes = Buffer.from('{}')),
    (f) => (f.input.sourceFiles[APPLICATION_SOURCE_FILES[0]] = Buffer.from('changed')),
    (f) => delete f.input.sourceFiles[APPLICATION_SOURCE_FILES[0]],
  ]) {
    const f = fixture()
    change(f)
    assert.throws(() => verifyRelease270ApplicationArtifacts(f.input))
  }
})
test('target/service/resource/source/URL and strict zero controls refuse before readback', async () => {
  for (const [key, value] of [
    ['RAILWAY_ENVIRONMENT', 'production'],
    ['RAILWAY_PROJECT_ID', 'other'],
    ['RAILWAY_ENVIRONMENT_ID', 'other'],
    ['RAILWAY_SERVICE_ID', 'other'],
    ['DATABASE_RESOURCE_ID', 'other'],
    ['REDIS_RESOURCE_ID', 'other'],
    ['STORAGE_RESOURCE_ID', 'other'],
    ['RAILWAY_GIT_COMMIT_SHA', 'c'.repeat(40)],
    ['RAILWAY_GIT_COMMIT_SHA', undefined],
    ['PATHFINDER_RELEASE_SHA', 'c'.repeat(40)],
    ['PATHFINDER_ALLOW_STAGING_MIGRATIONS', '1'],
    ['PATHFINDER_ALLOW_STAGING_MIGRATIONS', undefined],
    ['PATHFINDER_STAGING_MIGRATION_ONLY_HOLD', '1'],
    ['PATHFINDER_STAGING_MIGRATION_ONLY_HOLD', undefined],
    ['DIRECT_DATABASE_URL', 'postgresql://fictional@127.0.0.1:5432/pathfinder_staging'],
    [
      'DIRECT_DATABASE_URL',
      'postgresql://fictional@other.railway.internal:5432/pathfinder_staging',
    ],
    [
      'DIRECT_DATABASE_URL',
      'postgresql://fictional@database.railway.internal:5432/pathfinder_staging?options=-crole=other',
    ],
  ]) {
    const f = fixture()
    f.environment[key] = value
    let read = false
    await assert.rejects(
      admitRelease270Application({
        ...f,
        readSnapshot: async () => {
          read = true
          return f.snapshot
        },
        now: () => now,
      }),
    )
    assert.equal(read, false)
  }
})
test('unreviewed/expired/future/incomplete migration receipt refuses', () => {
  for (const change of [
    (r) => (r.applicationReleaseApproved = false),
    (r) => (r.independentRestoreVerified = false),
    (r) => (r.phase = 'outcome-unknown'),
    (r) => (r.state = 'predecessor269'),
    (r) => (r.expiresAt = iso(-1)),
    (r) => (r.approvedAt = iso(1)),
    (r) => (r.postgresMajor = 18),
    (r) => (r.independentReviewSha256 = undefined),
    (r) => (r.resources.database = 'other'),
  ]) {
    const f = fixture()
    change(f.artifacts.receipt)
    assert.throws(() => assertRelease270ApplicationReceipt(f.artifacts, now))
  }
})
test('269, extra/failed/altered physical ledger, catalog and security drift refuse', () => {
  for (const change of [
    (s) => s.ledger.pop(),
    (s) => s.ledger.push({ ...s.ledger[0], id: 'extra' }),
    (s) => (s.ledger[0].logs = 'failed'),
    (s) => (s.ledger[0].rolled_back_at = iso(-10000)),
    (s) => (s.ledger[0].checksum = 'c'.repeat(64)),
    (s) => (s.ledger[0].rowHash = 'c'.repeat(64)),
    (s) => (s.ledger[0].applied_steps_count = 0),
    (s) => (s.catalog.indexes[0].definition = 'changed'),
    (s) => (s.newSecurityHash = 'c'.repeat(64)),
    (s) => (s.existingSecurityHash = 'c'.repeat(64)),
    (s) => (s.policyHash = 'c'.repeat(64)),
    (s) => (s.postgresMajor = 16),
    (s) => (s.observedAt = iso(-60001)),
    (s) => (s.databaseName = 'other'),
  ]) {
    const f = fixture()
    change(f.snapshot)
    assert.throws(() => assertRelease270ApplicationSnapshot(f.snapshot, f.artifacts, now))
  }
})
test('live traffic and unrelated row/queue/session observations do not freeze app startup', () => {
  const f = fixture()
  Object.assign(f.snapshot, {
    activeQueueJobs: 999,
    blockingClientSessions: 999,
    tables: [{ hash: 'changed' }],
    sequenceStateHash: 'changed',
  })
  assert.equal(
    assertRelease270ApplicationSnapshot(f.snapshot, f.artifacts, now).state,
    'complete270',
  )
})
test('controls changed during a readback fail the final startup boundary', async () => {
  const f = fixture()
  await assert.rejects(
    admitRelease270Application({
      ...f,
      now: () => now,
      readSnapshot: async () => {
        f.environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD = '1'
        return f.snapshot
      },
    }),
    /hold-must-be-zero/,
  )
})
test('collector executes only finite SELECTs and transaction-local controls; no row mutation', async () => {
  const f = fixture(),
    statements = []
  const controls = new Set([
    'SET TRANSACTION READ ONLY',
    "SET LOCAL statement_timeout = '10000ms'",
    "SET LOCAL lock_timeout = '2000ms'",
    "SET LOCAL idle_in_transaction_session_timeout = '15000ms'",
    "SET LOCAL TIME ZONE 'UTC'",
    "SET LOCAL DateStyle = 'ISO, YMD'",
  ])
  const database = {
    $transaction: async (action, options) => {
      assert.deepEqual(options, { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 20000 })
      return action({
        $executeRawUnsafe: async (sql) => {
          assert.ok(controls.has(sql))
          statements.push(sql)
        },
        $queryRawUnsafe: async (sql) => {
          assert.match(sql, /^SELECT /)
          assert.ok(
            !/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE|pg_terminate_backend|pg_advisory)\b/iu.test(
              sql,
            ),
          )
          statements.push(sql)
          if (sql.includes('server_version_num'))
            return [{ databaseName: 'pathfinder_staging', serverVersionNum: 170006 }]
          if (sql.includes('to_jsonb(m)'))
            return f.snapshot.ledger.map(({ rowHash, ...row }) => ({ row, rowHash }))
          if (sql.includes('FROM pg_tables')) return f.snapshot.catalog.tables
          if (sql.includes('FROM information_schema.columns')) return f.snapshot.catalog.columns
          if (sql.includes('FROM pg_enum')) return f.snapshot.catalog.enums
          if (sql.includes('FROM pg_constraint')) return f.snapshot.catalog.constraints
          if (sql.includes('FROM pg_index i')) return f.snapshot.catalog.indexes
          if (sql.includes("p.prokind='f'")) return f.snapshot.catalog.functions
          if (sql.includes('FROM pg_trigger')) return f.snapshot.catalog.triggers
          return []
        },
      })
    },
  }
  const snapshot = await readRelease270ApplicationSnapshot(database, { now: () => now })
  assert.equal(statements[0], 'SET TRANSACTION READ ONLY')
  assert.equal(snapshot.ledger.length, 270)
  assert.equal(snapshot.postgresMajor, 17)
  assert.equal(snapshot.databaseName, 'pathfinder_staging')
  assert.ok(
    !statements.some((s) =>
      /pg_stat_activity|pg_sequences|FROM public\.(?!_prisma_migrations)/u.test(s),
    ),
  )
  // Match existing migration collector's empty-security hash composition.
  assert.equal(
    snapshot.newSecurityHash,
    applicationHash({ security: [], typeSecurity: [], policies: [], rowSecurity: [] }),
  )
})
test('CLI has no path/operation options and refuses unavailable host or closed controls', async () => {
  await assert.rejects(main(['--migrate'], {}), /no-options/)
  await assert.rejects(main([], {}))
  if (process.platform === 'linux')
    await assert.rejects(main([], fixture().environment), /executable-location/)
  const code = await readFile(
    new URL('./run-release270-staging-predeploy.mjs', import.meta.url),
    'utf8',
  )
  const library = await readFile(
    new URL('./lib/release270-application-admission.mjs', import.meta.url),
    'utf8',
  )
  assert.ok(!/from ['"]node:child_process/.test(code + library))
  assert.ok(
    !/\bspawn\(|execFile|migrate.*deploy|\$executeRawUnsafe\(['"](?:INSERT|UPDATE|DELETE|ALTER)/u.test(
      code + library,
    ),
  )
})

test('seal inventory covers the complete current relative import graph and fixed executable origins', async () => {
  const visited = new Set()
  const walk = async (name) => {
    if (visited.has(name)) return
    visited.add(name)
    const source = await readFile(path.join(root, name), 'utf8')
    for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.\.?\/[^'"]+)\1/g)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(name), match[2]))
      assert.ok(APPLICATION_SOURCE_FILES.includes(dependency), `unsealed dependency: ${dependency}`)
      await walk(dependency)
    }
  }
  await walk('scripts/run-release270-staging-predeploy.mjs')
  assert.deepEqual(
    [...visited].sort(),
    APPLICATION_SOURCE_FILES.filter((name) => name.endsWith('.mjs')).sort(),
  )
})
