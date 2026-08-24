import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

import { assertStagingMigrationAdmission } from './lib/staging-migration-admission.mjs'

const EXPECTED = Object.freeze({
  approval: 'torchiko-staging-lineage-to-163-20260824',
  environmentId: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  serviceId: '9fec9bdb-1915-4bee-8213-f6c3d434baa1',
  databaseResourceId: '7bd81064-588f-48a5-b138-1fc86691a09b',
  databaseName: 'pathfinder_staging',
  migrationCount: 163,
  baselineCount: 52,
  baselinePublicTableCount: 43,
  priorCompleteCount: 93,
  priorCompletePublicTableCount: 99,
  // Exact synthetic staging lineage observed after the reviewed Tochi foundation
  // tranche; ledger names and checksums are still verified below before deploy.
  capabilityBaselineCount: 112,
  capabilityBaselinePublicTableCount: 113,
  stagingBaselineCount: 125,
  stagingBaselinePublicTableCount: 126,
  preBillingCount: 132,
  preBillingPublicTableCount: 164,
  billingFoundationCount: 133,
  billingFoundationPublicTableCount: 175,
  previousReleaseCount: 134,
  previousReleasePublicTableCount: 175,
  b5CompleteCount: 141,
  b5CompletePublicTableCount: 193,
  firstMigration: '001_identity_foundation',
  baselineLastMigration: '20260809150000_add_evaluation_persistence',
  priorFinalMigration: '20260817000000_rebrand_torchiko',
  capabilityBaselineFinalMigration: '20260819130000_add_normalized_personality_dimensions',
  stagingBaselineFinalMigration: '20260819156000_add_operational_event_delivery_audit',
  preBillingFinalMigration: '20260820190000_harden_prospect_import_jobs',
  billingFoundationFinalMigration: '20260820210000_add_stripe_billing_foundation',
  previousReleaseFinalMigration: '20260821032000_allow_pending_stripe_customer_link',
  b5CompleteFinalMigration: '20260821201000_add_meeting_processing_capability',
  finalMigration: '20260824150000_add_internal_support_drafts',
  manifestHash: 'afad992aee7040faec8a048db4a65b264120b30a5744aa5ed159c92d6a3d252f',
  finalPublicTableCount: 206,
})

// These are the exact checksums preserved by the verified 52-row production
// ledger. The latter two differ from the canonical SQL only by CRLF line
// endings. The weekly-digest artifact is no longer present in Git history, so
// its resulting schema is fingerprinted before any later migration can run.
const VERIFIED_BASELINE_CHECKSUMS = Object.freeze({
  '20260413120000_add_weekly_digest':
    '88e85794d89206b53ed0d6d9a915ebd7a0393afb05dbfda6e19f19941e509e70',
  '20260413130000_add_job_records':
    'bf7604b3b637b44b79d0a707f1634a6b77166047835e61de8f47ea878f1da5bc',
  '20260619010000_analytics_rework':
    'ea926dcdbb82a6fcec63eb5d5fedca2bb4fd68380de5b20ac049975cef494156',
})

function fail(message) {
  throw new Error(`staging-migration-stop: ${message}`)
}

function validatedUrl(raw, label) {
  if (!raw) fail(`${label} is missing`)
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    fail(`${label} is not a URL`)
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    fail(`${label} is not PostgreSQL`)
  }
  if (!parsed.hostname.endsWith('.railway.internal')) {
    fail(`${label} is not a Railway-private target`)
  }
  if (decodeURIComponent(parsed.pathname.slice(1)) !== EXPECTED.databaseName) {
    fail(`${label} database name is not the approved staging database`)
  }
  return parsed
}

export function assertApprovedTarget(environment) {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') fail('environment label is not staging')
  if (environment.RAILWAY_ENVIRONMENT_ID !== EXPECTED.environmentId) {
    fail('Railway environment identity mismatch')
  }
  if (environment.RAILWAY_SERVICE_ID !== EXPECTED.serviceId) {
    fail('Railway service identity mismatch')
  }
  if (environment.DATABASE_RESOURCE_ID !== EXPECTED.databaseResourceId) {
    fail('database resource identity mismatch')
  }
  if (environment.PATHFINDER_STAGING_MIGRATION_APPROVAL !== EXPECTED.approval) {
    fail('exact migration approval token is missing')
  }

  const pooled = validatedUrl(environment.DATABASE_URL, 'DATABASE_URL')
  const direct = validatedUrl(environment.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL')
  if (pooled.hostname !== direct.hostname || pooled.port !== direct.port) {
    fail('pooled and direct URLs do not identify the same staging host')
  }
}

export async function readMigrationManifest(prismaDirectory) {
  const migrationRoot = path.join(prismaDirectory, 'migrations')
  const entries = await readdir(migrationRoot)
  const names = []
  for (const name of entries) {
    if ((await stat(path.join(migrationRoot, name))).isDirectory()) names.push(name)
  }
  names.sort()

  const rows = []
  const checksums = new Map()
  for (const name of names) {
    const sql = (await readFile(path.join(migrationRoot, name, 'migration.sql'), 'utf8')).replace(
      /\r\n/gu,
      '\n',
    )
    const checksum = createHash('sha256').update(sql).digest('hex')
    checksums.set(name, checksum)
    rows.push(`${name} ${checksum}`)
  }
  const hash = createHash('sha256')
    .update(`${rows.join('\n')}\n`)
    .digest('hex')
  return { names, checksums, hash }
}

export function assertFrozenManifest(manifest) {
  if (manifest.names.length !== EXPECTED.migrationCount) fail('migration count changed')
  if (manifest.names[0] !== EXPECTED.firstMigration) fail('first migration changed')
  if (manifest.names.at(-1) !== EXPECTED.finalMigration) fail('final migration changed')
  if (manifest.names[EXPECTED.baselineCount - 1] !== EXPECTED.baselineLastMigration) {
    fail('verified baseline boundary changed')
  }
  if (manifest.names[EXPECTED.priorCompleteCount - 1] !== EXPECTED.priorFinalMigration) {
    fail('prior complete boundary changed')
  }
  if (
    manifest.names[EXPECTED.capabilityBaselineCount - 1] !==
    EXPECTED.capabilityBaselineFinalMigration
  ) {
    fail('capability baseline boundary changed')
  }
  if (
    manifest.names[EXPECTED.stagingBaselineCount - 1] !== EXPECTED.stagingBaselineFinalMigration
  ) {
    fail('staging baseline boundary changed')
  }
  if (manifest.names[EXPECTED.preBillingCount - 1] !== EXPECTED.preBillingFinalMigration) {
    fail('pre-billing boundary changed')
  }
  if (
    manifest.names[EXPECTED.billingFoundationCount - 1] !== EXPECTED.billingFoundationFinalMigration
  ) {
    fail('billing foundation boundary changed')
  }
  if (
    manifest.names[EXPECTED.previousReleaseCount - 1] !== EXPECTED.previousReleaseFinalMigration
  ) {
    fail('previous staging release boundary changed')
  }
  if (manifest.names[EXPECTED.b5CompleteCount - 1] !== EXPECTED.b5CompleteFinalMigration) {
    fail('B.5 complete boundary changed')
  }
  if (manifest.hash !== EXPECTED.manifestHash) fail('migration manifest checksum changed')
}

function ledgerState(rows, manifest) {
  if (
    rows.length !== EXPECTED.baselineCount &&
    rows.length !== EXPECTED.priorCompleteCount &&
    rows.length !== EXPECTED.capabilityBaselineCount &&
    rows.length !== EXPECTED.stagingBaselineCount &&
    rows.length !== EXPECTED.preBillingCount &&
    rows.length !== EXPECTED.billingFoundationCount &&
    rows.length !== EXPECTED.previousReleaseCount &&
    rows.length !== EXPECTED.b5CompleteCount &&
    rows.length !== EXPECTED.migrationCount
  ) {
    fail(`unexpected ledger row count ${rows.length}`)
  }
  const expectedNames = manifest.names.slice(0, rows.length)
  const checksumMismatches = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const expectedName = expectedNames[index]
    if (row.migration_name !== expectedName) fail('ledger migration ordering/name mismatch')
    const expectedChecksum = manifest.checksums.get(expectedName)
    const verifiedBaselineChecksum = VERIFIED_BASELINE_CHECKSUMS[expectedName]
    if (
      row.checksum.toLowerCase() !== expectedChecksum &&
      row.checksum.toLowerCase() !== verifiedBaselineChecksum
    )
      checksumMismatches.push(`${expectedName}:${row.checksum.toLowerCase()}:${expectedChecksum}`)
    if (row.finished_at === null) fail(`unfinished migration ${expectedName}`)
    if (row.rolled_back_at !== null) fail(`rolled-back migration ${expectedName}`)
    if (typeof row.logs === 'string' && row.logs.trim() !== '') {
      fail(`migration logs are non-empty for ${expectedName}`)
    }
  }
  if (checksumMismatches.length > 0) {
    fail(`ledger checksum mismatches ${checksumMismatches.join(',')}`)
  }
  if (rows.length === EXPECTED.baselineCount) return 'baseline'
  if (rows.length === EXPECTED.priorCompleteCount) return 'prior-complete'
  if (rows.length === EXPECTED.capabilityBaselineCount) return 'capability-baseline'
  if (rows.length === EXPECTED.stagingBaselineCount) return 'staging-baseline'
  if (rows.length === EXPECTED.preBillingCount) return 'pre-billing'
  if (rows.length === EXPECTED.billingFoundationCount) return 'billing-foundation'
  if (rows.length === EXPECTED.previousReleaseCount) return 'previous-release'
  if (rows.length === EXPECTED.b5CompleteCount) return 'b5-complete'
  return 'complete'
}

function remainingMigrationNames(rows, manifest) {
  const state = ledgerState(rows, manifest)
  if (state === 'complete') return []
  return manifest.names.slice(rows.length)
}

export function assertBackupEvidenceMatchesLedger(admission, rows) {
  if (admission.dataPolicy !== 'preserve-existing') return
  if (!admission.backupEvidence || admission.backupEvidence.ledgerCount !== rows.length) {
    fail('backup evidence ledger count does not match the target database')
  }
}

async function assertVerifiedBaselineSchema(database, rows) {
  const weeklyRow = rows.find(
    ({ migration_name }) => migration_name === '20260413120000_add_weekly_digest',
  )
  if (
    !weeklyRow ||
    weeklyRow.checksum.toLowerCase() !==
      VERIFIED_BASELINE_CHECKSUMS['20260413120000_add_weekly_digest']
  ) {
    return
  }

  const enumRows = await database.$queryRawUnsafe(
    "SELECT e.enumlabel FROM pg_catalog.pg_enum e JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'WeeklyDigestStatus' ORDER BY e.enumsortorder",
  )
  const labels = enumRows.map(({ enumlabel }) => enumlabel).join(',')
  if (labels !== 'PENDING,PROCESSING,COMPLETE,FAILED') {
    fail('weekly digest enum fingerprint mismatch')
  }

  const [{ column_count: columnCount, required_columns: requiredColumns }] =
    await database.$queryRawUnsafe(
      "SELECT count(*)::int AS column_count, count(*) FILTER (WHERE column_name IN ('id','tenant_id','week_start','week_end','status','session_count','message_count','insights','generated_at','created_at'))::int AS required_columns FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'weekly_digests'",
    )
  if (columnCount !== 10 || requiredColumns !== 10) {
    fail('weekly digest column fingerprint mismatch')
  }

  const [{ constraint_count: constraintCount }] = await database.$queryRawUnsafe(
    "SELECT count(*)::int AS constraint_count FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace WHERE n.nspname = 'public' AND r.relname = 'weekly_digests' AND ((c.contype = 'p' AND c.conname = 'weekly_digests_pkey') OR (c.contype = 'f' AND c.conname = 'weekly_digests_tenant_id_fkey'))",
  )
  if (constraintCount !== 2) fail('weekly digest constraint fingerprint mismatch')

  const [{ index_count: indexCount }] = await database.$queryRawUnsafe(
    "SELECT count(*)::int AS index_count FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND tablename = 'weekly_digests' AND indexname IN ('weekly_digests_tenant_id_week_start_idx','weekly_digests_tenant_id_week_start_key')",
  )
  if (indexCount !== 2) fail('weekly digest index fingerprint mismatch')
}

async function ledgerRows(database) {
  return database.$queryRawUnsafe(
    'SELECT migration_name, checksum, finished_at, rolled_back_at, logs FROM public._prisma_migrations ORDER BY migration_name',
  )
}

async function publicTableCounts(database) {
  const tables = await database.$queryRawUnsafe(
    "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  )
  const counts = new Map()
  for (const { tablename } of tables) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(tablename)) fail('unsafe table identifier')
    const [row] = await database.$queryRawUnsafe(
      `SELECT count(*)::text AS count FROM public."${tablename}"`,
    )
    counts.set(tablename, row.count)
  }
  return counts
}

async function assertPostMigrationIntegrity(database, manifest) {
  const rows = await ledgerRows(database)
  if (ledgerState(rows, manifest) !== 'complete') fail('final ledger is incomplete')

  const [{ count: tableCount }] = await database.$queryRawUnsafe(
    "SELECT count(*)::int AS count FROM pg_catalog.pg_tables WHERE schemaname = 'public'",
  )
  if (tableCount !== EXPECTED.finalPublicTableCount) {
    fail(`unexpected final public table count ${tableCount}`)
  }
  const [{ count: invalidIndexes }] = await database.$queryRawUnsafe(
    "SELECT count(*)::int AS count FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT i.indisvalid",
  )
  if (invalidIndexes !== 0) fail('invalid public indexes remain')
  const [{ count: unvalidatedConstraints }] = await database.$queryRawUnsafe(
    "SELECT count(*)::int AS count FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public' AND NOT c.convalidated",
  )
  if (unvalidatedConstraints !== 0) fail('unvalidated public constraints remain')
}

function runPrismaDeploy(cli, schema, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['migrate', 'deploy', '--schema', schema], {
      env: environment,
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`Prisma migrate deploy failed (${signal ?? code})`))
    })
  })
}

async function main() {
  const admission = assertStagingMigrationAdmission(process.env)
  assertApprovedTarget(process.env)
  console.log('staging-migration: exact Railway target identity accepted')
  const prismaDirectory = process.env.PATHFINDER_PRISMA_DIR ?? '/migration/prisma'
  const prismaCli = process.env.PATHFINDER_PRISMA_CLI ?? '/migration/node_modules/.bin/prisma'
  const manifest = await readMigrationManifest(prismaDirectory)
  assertFrozenManifest(manifest)
  console.log(`staging-migration: frozen ${EXPECTED.migrationCount}-file manifest accepted`)

  const { PrismaClient } = await import('@prisma/client')
  const database = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL })
  try {
    const initialLedger = await ledgerRows(database)
    const initialState = ledgerState(initialLedger, manifest)
    assertBackupEvidenceMatchesLedger(admission, initialLedger)
    await assertVerifiedBaselineSchema(database, initialLedger)
    console.log(`staging-migration: exact ${initialLedger.length}-row ledger accepted`)
    if (initialState === 'complete') {
      await assertPostMigrationIntegrity(database, manifest)
      console.log(
        `staging-migration: already complete (${EXPECTED.migrationCount}/${EXPECTED.migrationCount}); integrity checks passed`,
      )
      return
    }

    const beforeCounts = await publicTableCounts(database)
    const expectedInitialTableCount =
      initialState === 'baseline'
        ? EXPECTED.baselinePublicTableCount
        : initialState === 'prior-complete'
          ? EXPECTED.priorCompletePublicTableCount
          : initialState === 'capability-baseline'
            ? EXPECTED.capabilityBaselinePublicTableCount
            : initialState === 'pre-billing'
              ? EXPECTED.preBillingPublicTableCount
              : initialState === 'billing-foundation'
                ? EXPECTED.billingFoundationPublicTableCount
                : initialState === 'previous-release'
                  ? EXPECTED.previousReleasePublicTableCount
                  : initialState === 'b5-complete'
                    ? EXPECTED.b5CompletePublicTableCount
                    : EXPECTED.stagingBaselinePublicTableCount
    if (beforeCounts.size !== expectedInitialTableCount) {
      fail(`unexpected initial public table count ${beforeCounts.size}`)
    }
    await runPrismaDeploy(prismaCli, path.join(prismaDirectory, 'schema.prisma'), process.env)
    await assertPostMigrationIntegrity(database, manifest)
    const afterCounts = await publicTableCounts(database)
    for (const [table, count] of beforeCounts) {
      if (table === '_prisma_migrations') continue
      if (afterCounts.get(table) !== count)
        fail(`row count changed for pre-existing table ${table}`)
    }
    console.log(
      `staging-migration: applied ${EXPECTED.migrationCount - initialLedger.length} migrations; ${EXPECTED.migrationCount}/${EXPECTED.migrationCount} ledger and integrity checks passed`,
    )
  } finally {
    await database.$disconnect()
  }
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (isMain) {
  main().catch(async (error) => {
    console.error(
      error instanceof Error ? error.message : 'staging-migration-stop: unknown failure',
    )
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    process.exitCode = 1
  })
}

export { EXPECTED, VERIFIED_BASELINE_CHECKSUMS, ledgerState, remainingMigrationNames }
