import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const EXPECTED = Object.freeze({
  approval: 'pathfinder-v2-lineage-52-to-90-20260813',
  environmentId: 'a7a394fc-aa4e-4a45-bd3c-904419a67818',
  serviceId: '9fec9bdb-1915-4bee-8213-f6c3d434baa1',
  databaseResourceId: '7bd81064-588f-48a5-b138-1fc86691a09b',
  databaseName: 'pathfinder_staging',
  migrationCount: 90,
  baselineCount: 52,
  baselinePublicTableCount: 43,
  firstMigration: '001_identity_foundation',
  baselineLastMigration: '20260809150000_add_evaluation_persistence',
  finalMigration: '20260812001700_add_offboarding_export_finalization',
  manifestHash: '0a1fa6265665304dbdfdf190e9fbefe9fd275ce72052d022ccef042a554b0583',
  finalPublicTableCount: 99,
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
  if (manifest.hash !== EXPECTED.manifestHash) fail('migration manifest checksum changed')
}

function ledgerState(rows, manifest) {
  if (rows.length !== EXPECTED.baselineCount && rows.length !== EXPECTED.migrationCount) {
    fail(`unexpected ledger row count ${rows.length}`)
  }
  const expectedNames = manifest.names.slice(0, rows.length)
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    const expectedName = expectedNames[index]
    if (row.migration_name !== expectedName) fail('ledger migration ordering/name mismatch')
    if (row.checksum.toLowerCase() !== manifest.checksums.get(expectedName)) {
      fail(`ledger checksum mismatch for ${expectedName}`)
    }
    if (row.finished_at === null) fail(`unfinished migration ${expectedName}`)
    if (row.rolled_back_at !== null) fail(`rolled-back migration ${expectedName}`)
    if (typeof row.logs === 'string' && row.logs.trim() !== '') {
      fail(`migration logs are non-empty for ${expectedName}`)
    }
  }
  return rows.length === EXPECTED.baselineCount ? 'baseline' : 'complete'
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
  assertApprovedTarget(process.env)
  console.log('staging-migration: exact Railway target identity accepted')
  const prismaDirectory = process.env.PATHFINDER_PRISMA_DIR ?? '/migration/prisma'
  const prismaCli = process.env.PATHFINDER_PRISMA_CLI ?? '/migration/node_modules/.bin/prisma'
  const manifest = await readMigrationManifest(prismaDirectory)
  assertFrozenManifest(manifest)
  console.log('staging-migration: frozen 90-file manifest accepted')

  const { PrismaClient } = await import('@prisma/client')
  const database = new PrismaClient({ datasourceUrl: process.env.DIRECT_DATABASE_URL })
  try {
    const initialLedger = await ledgerRows(database)
    const initialState = ledgerState(initialLedger, manifest)
    console.log(`staging-migration: exact ${initialLedger.length}-row ledger accepted`)
    if (initialState === 'complete') {
      await assertPostMigrationIntegrity(database, manifest)
      console.log('staging-migration: already complete (90/90); integrity checks passed')
      return
    }

    const beforeCounts = await publicTableCounts(database)
    if (beforeCounts.size !== EXPECTED.baselinePublicTableCount) {
      fail(`unexpected baseline public table count ${beforeCounts.size}`)
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
      'staging-migration: applied 38 migrations; 90/90 ledger and integrity checks passed',
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

export { EXPECTED, ledgerState }
