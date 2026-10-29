// Read-only staging application admission. No migration or consumer-hold authority.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { STAGING_RELEASE_TARGET } from './staging-release-admission.mjs'
import {
  assertRelease270Ledger,
  assertRelease270Manifest,
  RELEASE270,
} from './release270-migration-contract.mjs'
import { assertRelease270Catalog, readRelease270Catalog } from './release270-catalog-contract.mjs'

export const APPLICATION_SEAL_SCHEMA = 'torchiko-release270-application-image/v1'
export const APPLICATION_RECEIPT_SCHEMA = 'torchiko-release270-application-release/v1'
export const APPLICATION_MODULE_URL = import.meta.url
export const APPLICATION_SOURCE_FILES = Object.freeze([
  'scripts/run-release270-staging-predeploy.mjs',
  'scripts/lib/release270-application-admission.mjs',
  'scripts/lib/release270-migration-contract.mjs',
  'scripts/lib/release270-catalog-contract.mjs',
  'scripts/lib/staging-release-admission.mjs',
  'scripts/lib/staging-health-admission.mjs',
  'scripts/lib/staging-runtime-audit.mjs',
  'scripts/lib/staging-topology-admission.mjs',
  'scripts/lib/staging-migration-admission.mjs',
  'scripts/lib/operator-cli-failure.mjs',
  'scripts/run-staging-migration-predeploy.mjs',
  'packages/db/prisma/schema.prisma',
  'pnpm-lock.yaml',
])
const HASH = /^[a-f0-9]{64}$/u
const SHA = /^[a-f0-9]{40}$/u
const refreshTables = ['embedding_venue_refresh_records', 'embedding_venue_refreshes']
export const applicationHash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const applicationBytesHash = (value) => createHash('sha256').update(value).digest('hex')
const exactHash = (value) => assert.match(value ?? '', HASH, 'release270-application-hash-required')
const time = (value) => {
  assert.equal(typeof value, 'string', 'release270-application-time-required')
  const result = Date.parse(value)
  assert.ok(Number.isFinite(result), 'release270-application-time-invalid')
  assert.equal(new Date(result).toISOString(), value, 'release270-application-canonical-time')
  return result
}
function json(bytes, max, expectedHash) {
  exactHash(expectedHash)
  assert.ok(
    Buffer.isBuffer(bytes) || typeof bytes === 'string',
    'release270-application-bytes-required',
  )
  assert.ok(
    Buffer.byteLength(bytes) > 0 && Buffer.byteLength(bytes) <= max,
    'release270-application-artifact-size',
  )
  assert.equal(applicationBytesHash(bytes), expectedHash, 'release270-application-artifact-seal')
  return JSON.parse(bytes.toString())
}

// expectedSealSha256 must come from independently reviewed deployment configuration,
// not from the seal itself. Bytes are never synthesized from the observed database.
export function verifyRelease270ApplicationArtifacts({
  sealBytes,
  receiptBytes,
  referenceBytes,
  expectedSealSha256,
  sourceFiles,
  manifest,
}) {
  const seal = json(sealBytes, 64 * 1024, expectedSealSha256)
  assert.equal(seal.schema, APPLICATION_SEAL_SCHEMA)
  assert.match(seal.releaseSha ?? '', SHA, 'release270-application-source-sha')
  assertRelease270Manifest(manifest)
  assert.equal(seal.manifestHash, RELEASE270.manifestHash, 'release270-application-manifest-seal')
  assert.deepEqual(
    Object.keys(seal.files ?? {}).sort(),
    [...APPLICATION_SOURCE_FILES].sort(),
    'release270-application-source-file-set',
  )
  for (const name of APPLICATION_SOURCE_FILES) {
    exactHash(seal.files[name])
    assert.ok(
      Buffer.isBuffer(sourceFiles?.[name]) || typeof sourceFiles?.[name] === 'string',
      'release270-application-source-file-required',
    )
    assert.equal(
      applicationBytesHash(sourceFiles[name]),
      seal.files[name],
      'release270-application-source-file-seal',
    )
  }
  exactHash(seal.trackedSourceArchiveSha256)
  const receipt = json(receiptBytes, 128 * 1024, seal.receiptSha256)
  const reference = json(referenceBytes, 16 * 1024 * 1024, seal.referenceSha256)
  assert.equal(receipt.schema, APPLICATION_RECEIPT_SCHEMA)
  assert.equal(receipt.releaseSha, seal.releaseSha, 'release270-application-receipt-source')
  assert.equal(receipt.manifestHash, seal.manifestHash)
  assert.equal(
    receipt.referenceReleaseSha,
    seal.releaseSha,
    'release270-application-reference-source',
  )
  // Semantics and independently pinned raw artifact bytes are both checked.
  assertRelease270Catalog(reference, { reference, referenceHash: receipt.catalogHash })
  return Object.freeze({ seal, receipt, reference, manifest, sealSha256: expectedSealSha256 })
}

function databaseUrl(value) {
  assert.equal(typeof value, 'string', 'release270-application-database-url-required')
  const url = new URL(value)
  assert.ok(
    ['postgresql:', 'postgres:'].includes(url.protocol),
    'release270-application-database-protocol',
  )
  assert.match(
    url.hostname,
    /^[a-z0-9][a-z0-9.-]*\.railway\.internal$/u,
    'release270-application-private-database-required',
  )
  assert.equal(
    decodeURIComponent(url.pathname.slice(1)),
    'pathfinder_staging',
    'release270-application-database-name',
  )
  assert.equal(url.hash, '', 'release270-application-database-fragment')
  // Forbid connection options that could execute a role/search-path/options override.
  for (const key of url.searchParams.keys())
    assert.ok(
      ['connection_limit', 'connect_timeout', 'pool_timeout', 'sslmode'].includes(key),
      'release270-application-database-option',
    )
  return url
}

export function assertRelease270ApplicationTarget(environment, artifacts) {
  const { receipt, seal } = artifacts
  assert.equal(environment.RAILWAY_ENVIRONMENT, 'staging', 'release270-application-staging-only')
  assert.equal(
    environment.RAILWAY_PROJECT_ID,
    STAGING_RELEASE_TARGET.projectId,
    'release270-application-project',
  )
  assert.equal(
    environment.RAILWAY_ENVIRONMENT_ID,
    STAGING_RELEASE_TARGET.environmentId,
    'release270-application-environment',
  )
  const service = Object.entries(STAGING_RELEASE_TARGET.services).find(
    ([, id]) => id === environment.RAILWAY_SERVICE_ID,
  )?.[0]
  assert.ok(service, 'release270-application-service')
  for (const [resource, key] of [
    ['database', 'DATABASE_RESOURCE_ID'],
    ['redis', 'REDIS_RESOURCE_ID'],
    ['storage', 'STORAGE_RESOURCE_ID'],
  ])
    assert.equal(
      environment[key],
      STAGING_RELEASE_TARGET.resources[resource],
      'release270-application-resource',
    )
  assert.match(
    environment.RAILWAY_GIT_COMMIT_SHA ?? '',
    SHA,
    'release270-application-provider-source-required',
  )
  assert.equal(
    environment.RAILWAY_GIT_COMMIT_SHA,
    seal.releaseSha,
    'release270-application-provider-source',
  )
  if (environment.PATHFINDER_RELEASE_SHA !== undefined)
    assert.equal(
      environment.PATHFINDER_RELEASE_SHA,
      seal.releaseSha,
      'release270-application-configured-source',
    )
  assert.equal(
    environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS,
    '0',
    'release270-application-opt-in-must-be-zero',
  )
  assert.equal(
    environment.PATHFINDER_STAGING_MIGRATION_ONLY_HOLD,
    '0',
    'release270-application-hold-must-be-zero',
  )
  const pooled = databaseUrl(environment.DATABASE_URL)
  const direct = databaseUrl(environment.DIRECT_DATABASE_URL)
  assert.equal(pooled.hostname, direct.hostname, 'release270-application-host-mismatch')
  assert.equal(pooled.port || '5432', direct.port || '5432', 'release270-application-port-mismatch')
  assert.equal(direct.hostname, receipt.databaseHost, 'release270-application-receipt-host')
  assert.equal(direct.port || '5432', receipt.databasePort, 'release270-application-receipt-port')
  return { service, releaseSha: seal.releaseSha }
}

export function assertRelease270ApplicationReceipt(artifacts, now = Date.now()) {
  const { receipt, seal } = artifacts
  assert.equal(receipt.schema, APPLICATION_RECEIPT_SCHEMA)
  assert.equal(receipt.environment, 'staging')
  assert.equal(receipt.projectId, STAGING_RELEASE_TARGET.projectId)
  assert.equal(receipt.environmentId, STAGING_RELEASE_TARGET.environmentId)
  assert.deepEqual(
    receipt.resources,
    STAGING_RELEASE_TARGET.resources,
    'release270-application-receipt-resources',
  )
  assert.equal(receipt.releaseSha, seal.releaseSha)
  assert.equal(receipt.referenceReleaseSha, seal.releaseSha)
  assert.equal(receipt.manifestHash, RELEASE270.manifestHash)
  assert.equal(receipt.phase, 'verified', 'release270-application-unverified-migration')
  assert.equal(receipt.state, 'complete270', 'release270-application-incomplete-migration')
  assert.equal(
    receipt.applicationReleaseApproved,
    true,
    'release270-application-explicit-release-required',
  )
  assert.equal(
    receipt.independentRestoreVerified,
    true,
    'release270-application-independent-restore-required',
  )
  for (const key of [
    'migrationJournalSha256',
    'backupSha256',
    'restoreProofSha256',
    'independentReviewSha256',
    'physicalLedgerHash',
    'newSecurityHash',
    'existingSecurityHash',
    'policyHash',
    'catalogHash',
  ])
    exactHash(receipt[key])
  assert.ok(
    [16, 17].includes(receipt.postgresMajor),
    'release270-application-reviewed-postgres-major',
  )
  assert.ok(
    Array.isArray(receipt.reconciledZeroStepRows),
    'release270-application-zero-step-reconciliation',
  )
  const completed = time(receipt.completedAt),
    approved = time(receipt.approvedAt),
    expires = time(receipt.expiresAt)
  assert.ok(
    completed <= approved &&
      approved <= now &&
      now <= expires &&
      expires > approved &&
      expires - completed <= 86_400_000,
    'release270-application-receipt-expired-or-future',
  )
  return receipt
}

// No table content/queue/session/sequence-value snapshot: normal app traffic is
// allowed. Only immutable ledger, schema and security must match the reviewed receipt.
export function assertRelease270ApplicationSnapshot(snapshot, artifacts, now = Date.now()) {
  const receipt = assertRelease270ApplicationReceipt(artifacts, now)
  const observed = time(snapshot.observedAt)
  assert.ok(observed <= now && now - observed <= 60_000, 'release270-application-stale-readback')
  assert.equal(
    snapshot.databaseName,
    'pathfinder_staging',
    'release270-application-observed-database',
  )
  assert.equal(
    snapshot.postgresMajor,
    receipt.postgresMajor,
    'release270-application-postgres-major',
  )
  const state = assertRelease270Ledger(snapshot.ledger, artifacts.manifest, receipt)
  assert.equal(state.state, 'complete270', 'release270-application-complete270-required')
  assert.deepEqual(state.pending, [])
  assert.equal(
    applicationHash(snapshot.ledger),
    receipt.physicalLedgerHash,
    'release270-application-physical-ledger-drift',
  )
  assert.equal(snapshot.catalog.tables.length, RELEASE270.publicTableCount)
  assertRelease270Catalog(snapshot.catalog, {
    reference: artifacts.reference,
    referenceHash: receipt.catalogHash,
  })
  for (const key of ['newSecurityHash', 'existingSecurityHash', 'policyHash'])
    assert.equal(snapshot[key], receipt[key], `release270-application-${key}-drift`)
  return { state: 'complete270', migrationAuthorityGranted: false }
}

export async function readRelease270ApplicationSnapshot(database, { now = Date.now } = {}) {
  const observedAt = new Date(now()).toISOString()
  return database.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'")
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2000ms'")
      await tx.$executeRawUnsafe("SET LOCAL idle_in_transaction_session_timeout = '15000ms'")
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'")
      await tx.$executeRawUnsafe("SET LOCAL DateStyle = 'ISO, YMD'")
      const query = (sql) => tx.$queryRawUnsafe(sql)
      const [server] = await query(
        `SELECT current_database() AS "databaseName", current_setting('server_version_num')::int AS "serverVersionNum"`,
      )
      assert.ok(Number.isInteger(server?.serverVersionNum) && server.serverVersionNum >= 100000)
      const catalog = await readRelease270Catalog(query)
      const physical = await query(
        `SELECT to_jsonb(m) AS row, encode(sha256(convert_to(to_jsonb(m)::text,'UTF8')),'hex') AS "rowHash" FROM public._prisma_migrations m ORDER BY migration_name,id`,
      )
      const ledger = physical.map(({ row, rowHash }) => ({
        ...row,
        logs: row.logs === null || row.logs === '' ? row.logs : '[nonempty]',
        rowHash,
      }))
      const policies = await query(
        "SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' ORDER BY tablename,policyname",
      )
      const rowSecurity = await query(
        "SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p') ORDER BY c.relname",
      )
      const security = await query(
        `SELECT 'relation:'||c.relname AS identity,pg_get_userbyid(c.relowner) AS owner,coalesce(c.relacl::text,'') AS acl,coalesce(t.relname,c.relname) AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_index i ON i.indexrelid=c.oid LEFT JOIN pg_class t ON t.oid=i.indrelid WHERE n.nspname='public' ORDER BY c.relname`,
      )
      const columnSecurity = await query(
        "SELECT c.relname AS table_name,a.attname AS column_name,c.relkind::text AS kind,pg_get_userbyid(c.relowner) AS owner,a.attacl::text AS acl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum",
      )
      const otherSecurity = await query(
        `SELECT 'function:'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS identity,pg_get_userbyid(p.proowner) AS owner,coalesce(p.proacl::text,'') AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' UNION ALL SELECT 'schema:public',pg_get_userbyid(nspowner),coalesce(nspacl::text,'') FROM pg_namespace WHERE nspname='public' UNION ALL SELECT 'defaults:'||pg_get_userbyid(d.defaclrole)||':'||coalesce(n.nspname,'global')||':'||d.defaclobjtype::text,pg_get_userbyid(d.defaclrole),d.defaclacl::text FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE n.nspname='public' OR d.defaclnamespace=0 ORDER BY identity`,
      )
      const typeSecurity = await query(
        "SELECT t.typname,pg_get_userbyid(t.typowner) AS owner,coalesce(t.typacl::text,'') AS acl,(coalesce(base.typname,t.typname) IN ('EmbeddingVenueRefreshStatus','EmbeddingVenueRefreshRecordStatus','embedding_venue_refreshes','embedding_venue_refresh_records')) AS is_new FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace LEFT JOIN pg_type base ON base.oid=t.typelem WHERE n.nspname='public' ORDER BY t.typname",
      )
      return {
        observedAt,
        databaseName: server.databaseName,
        postgresMajor: Math.floor(server.serverVersionNum / 10000),
        ledger,
        catalog,
        newSecurityHash: applicationHash({
          security: security.filter((r) => refreshTables.includes(r.table_name)),
          columnSecurity: columnSecurity.filter((r) => refreshTables.includes(r.table_name)),
          typeSecurity: typeSecurity.filter((r) => r.is_new),
          policies: policies.filter((r) => refreshTables.includes(r.tablename)),
          rowSecurity: rowSecurity.filter((r) => refreshTables.includes(r.relname)),
        }),
        policyHash: applicationHash({
          policies,
          rowSecurity: rowSecurity.filter((r) => !refreshTables.includes(r.relname)),
        }),
        existingSecurityHash: applicationHash({
          security: security.filter((r) => !refreshTables.includes(r.table_name)),
          columnSecurity: columnSecurity.filter((r) => !refreshTables.includes(r.table_name)),
          otherSecurity,
          typeSecurity: typeSecurity.filter((r) => !r.is_new),
        }),
      }
    },
    { isolationLevel: 'RepeatableRead', maxWait: 5000, timeout: 20000 },
  )
}

export async function admitRelease270Application({
  environment,
  artifacts,
  readSnapshot,
  now = Date.now,
}) {
  const target = assertRelease270ApplicationTarget(environment, artifacts)
  assertRelease270ApplicationReceipt(artifacts, now())
  const snapshot = await readSnapshot()
  assertRelease270ApplicationSnapshot(snapshot, artifacts, now())
  // Refuse an in-process control/source change during readback too.
  assertRelease270ApplicationTarget(environment, artifacts)
  return {
    kind: 'release270-application-admitted',
    ...target,
    state: 'complete270',
    migrationAuthorityGranted: false,
  }
}
