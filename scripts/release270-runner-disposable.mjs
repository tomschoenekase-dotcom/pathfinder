// Hosted fictional integration only. No operational target override is exported.
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdir, cp, readFile, writeFile, open } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeFileSync, appendFileSync } from 'node:fs'
import { validateDisposableDatabaseUrl } from './lib/disposable-prisma-migration.mjs'
import { fixtureSql } from './lib/release270-compatibility.mjs'
import { fixtureSql269, seedRelease270DormantRedis } from './lib/release270-disposable-fixtures.mjs'
import {
  preflightRelease270,
  runRelease270,
  withRelease270Lock,
  spawnRelease270Migration,
} from './run-release270-migration.mjs'
import { EXPECTED, readMigrationManifest } from './run-staging-migration-predeploy.mjs'
import { RELEASE270 } from './lib/release270-migration-contract.mjs'
import { assertRelease269Manifest } from './lib/release269-migration-contract.mjs'
import { release270CatalogHash } from './lib/release270-catalog-contract.mjs'
import { hashRelease270, readRelease270Snapshot } from './lib/release270-readback.mjs'
import {
  RESTORE_SECURITY_SQL,
  assertRelease270RestoreEquivalent,
} from './lib/release270-restore-equivalence.mjs'
import {
  RELEASE269_STAGING_REDIS,
  readRelease269StagingQueues,
} from './lib/release269-queue-readback.mjs'
import {
  RELEASE270_STAGING_APPROVAL,
  RELEASE270_STAGING_PROOF_SCHEMA,
  release270CutoffHash,
} from './lib/release270-staging-admission.mjs'

export const SOURCE_DATABASE = 'pathfinder_disposable_release270_runner'
export const RESTORE_DATABASE = 'pathfinder_disposable_release270_restore'
export const REFERENCE_DATABASE = 'pathfinder_disposable_release270_reference'
export function guardRelease270Disposable(env) {
  assert.equal(env.GITHUB_ACTIONS, 'true', 'hosted disposable CI only')
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted', 'github-hosted runner required')
  assert.equal(env.RELEASE270_RUNNER_CONFIRM, SOURCE_DATABASE)
  for (const key of Object.keys(env))
    assert.ok(
      !/^(?:node_options|node_path|prisma_config_path|prisma_.*(?:engine|binary|library)|pg(?:host|port|database|user|password|service|passfile|options|ssl).*)$/iu.test(
        key,
      ),
      'disposable override refused',
    )
  const source = validateDisposableDatabaseUrl(
    env.PATHFINDER_DISPOSABLE_DATABASE_URL,
    SOURCE_DATABASE,
  )
  const restore = validateDisposableDatabaseUrl(
    env.RELEASE270_RESTORE_DATABASE_URL,
    RESTORE_DATABASE,
  )
  const reference = validateDisposableDatabaseUrl(
    env.RELEASE270_REFERENCE_DATABASE_URL,
    REFERENCE_DATABASE,
  )
  assert.equal(source.host, restore.host)
  assert.equal(source.port, restore.port)
  assert.equal(source.host, reference.host)
  assert.equal(source.port, reference.port)
  const redis = new URL(env.RELEASE270_DISPOSABLE_REDIS_URL)
  assert.equal(redis.protocol, 'redis:')
  assert.equal(redis.hostname, '127.0.0.1')
  assert.ok(
    redis.port &&
      !redis.search &&
      !redis.hash &&
      !redis.username &&
      !redis.password &&
      ['', '/', '/0'].includes(redis.pathname),
  )
  return {
    source: source.canonicalUrl,
    restore: restore.canonicalUrl,
    reference: reference.canonicalUrl,
    redis: redis.toString(),
  }
}

export async function main(env = process.env, outputArg = process.argv[2]) {
  const target = guardRelease270Disposable(env)
  const root = fileURLToPath(new URL('..', import.meta.url))
  const output = path.resolve(outputArg ?? '')
  assert.ok(
    outputArg && path.relative(root, output).startsWith('..'),
    'new external artifact directory required',
  )
  await mkdir(output, { recursive: false })
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 }).trim()
  const releaseSha = git('rev-parse', 'HEAD')
  const runtime = await preflightRelease270(root, releaseSha, env)
  const { PrismaClient, Redis, manifest, cli, prismaDirectory } = runtime
  const save = (name, value) =>
    writeFile(path.join(output, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
  const clean = Object.fromEntries(
    ['PATH', 'HOME', 'TMP', 'TEMP'].filter((key) => env[key]).map((key) => [key, env[key]]),
  )
  let serial = 0
  const command = (name, args, extra = {}, input) => {
    const log = path.join(output, `${String(++serial).padStart(3, '0')}-${path.basename(name)}.log`)
    const sanitized = (value) =>
      String(value ?? '').replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gu, '[DISPOSABLE_URL]')
    try {
      const result = execFileSync(name, args, {
        cwd: root,
        env: { ...clean, ...extra },
        timeout: 180_000,
        maxBuffer: 32 * 1024 * 1024,
        input,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      })
      writeFileSync(
        log,
        name === 'pg_dump' ? 'archive captured; binary content omitted\n' : sanitized(result),
      )
      return result
    } catch (error) {
      writeFileSync(
        log,
        sanitized(error.stdout) +
          '\n' +
          sanitized(error.stderr) +
          `\nexit:${error.status ?? 'unknown'}\n`,
      )
      throw new Error(`release270-disposable-command-failed:${serial}`)
    }
  }
  const db = (url) => new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` })
  const pg = (url) => {
    const parsed = new URL(url)
    return {
      PGHOST: parsed.hostname,
      PGPORT: parsed.port,
      PGDATABASE: parsed.pathname.slice(1),
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
    }
  }
  const execute = async (url, action) => {
    const client = db(url)
    try {
      return await action(client)
    } finally {
      await client.$disconnect()
    }
  }
  for (const url of [target.source, target.restore, target.reference])
    await execute(url, async (client) => {
      const [row] = await client.$queryRawUnsafe(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'",
      )
      assert.equal(row.count, 0, 'fresh empty database required; never reset')
    })
  const projected = async (count) => {
    const directory = path.join(output, `prisma${count}`)
    await mkdir(path.join(directory, 'migrations'), { recursive: true })
    for (const file of ['schema.prisma', 'migrations/migration_lock.toml'])
      await cp(path.join(prismaDirectory, file), path.join(directory, file))
    for (const name of manifest.names.slice(0, count))
      await cp(
        path.join(prismaDirectory, 'migrations', name),
        path.join(directory, 'migrations', name),
        { recursive: true },
      )
    if (count === 269) assertRelease269Manifest(await readMigrationManifest(directory))
    return directory
  }
  const migrate = (url, directory) =>
    command(
      process.execPath,
      [cli, 'migrate', 'deploy', '--schema', path.join(directory, 'schema.prisma')],
      { DATABASE_URL: url, DIRECT_DATABASE_URL: url },
    )
  const predecessor267 = await projected(267)
  const predecessor269 = await projected(269)
  migrate(target.source, predecessor267)
  // psql supports multi-statement fixture transactions; Prisma raw SQL does not.
  const sql = (url, text) => command('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1'], pg(url), text)
  sql(target.source, fixtureSql)
  migrate(target.source, predecessor269)
  sql(target.source, fixtureSql269)
  const setupRedis = new Redis(target.redis, { lazyConnect: true })
  try {
    await setupRedis.connect()
    await seedRelease270DormantRedis(setupRedis, { confirm: 'fictional-release270-disposable' })
  } finally {
    setupRedis.disconnect()
  }

  // These resource labels satisfy pure contract assertions only. Factories below
  // exclusively route to validated loopback services, never to these hostnames.
  const environment = {
    RAILWAY_ENVIRONMENT: 'staging',
    RAILWAY_ENVIRONMENT_ID: EXPECTED.environmentId,
    RAILWAY_SERVICE_ID: EXPECTED.serviceId,
    RAILWAY_PROJECT_ID: RELEASE269_STAGING_REDIS.project,
    DATABASE_RESOURCE_ID: EXPECTED.databaseResourceId,
    RAILWAY_GIT_COMMIT_SHA: releaseSha,
    REDIS_RESOURCE_ID: RELEASE269_STAGING_REDIS.resource,
    REDIS_URL: `redis://${RELEASE269_STAGING_REDIS.host}:6379`,
    DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
    DIRECT_DATABASE_URL: 'postgresql://fictional@database.railway.internal:5432/pathfinder_staging',
    PATHFINDER_ALLOW_STAGING_MIGRATIONS: '1',
    PATHFINDER_STAGING_MIGRATION_ONLY_HOLD: '1',
    PATHFINDER_CONFIRM_STAGING_DATA_POLICY: 'preserve-existing',
    PATHFINDER_STAGING_SPEND_CEILING_USD: '1',
    PATHFINDER_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_CONFIRM_STAGING_DATABASE_HOST: 'database.railway.internal',
    PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST: 'database.railway.internal',
    PATHFINDER_CONFIRM_STAGING_DATABASE_NAME: 'pathfinder_staging',
    PATHFINDER_STAGING_BACKUP_RELEASE_SHA: releaseSha,
    PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE: EXPECTED.databaseResourceId,
    PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE: 'fictional-independent-backup',
    PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE: 'fictional-independent-backup',
    PATHFINDER_STAGING_BACKUP_LEDGER_COUNT: '269',
  }
  const collectorHash = hashRelease270({ scope: 'fictional-disposable-transport-only', releaseSha })
  const stable = {
    schema: 'torchiko-release270-consumer-inventory/v1',
    releaseSha,
    resource: RELEASE269_STAGING_REDIS.resource,
    coverage: 'all-staging-deployed-consumers',
    unexpectedConsumers: 0,
    consumersHeld: true,
    inventory: [
      {
        serviceId: 'fictional-disabled-consumer',
        consumersHeld: true,
        workerFlags: { FICTIONAL_WORKER_ENABLED: '0' },
      },
    ],
  }
  const inventoryHash = hashRelease270(stable)
  const observations = []
  const snapshot = (database, lockPid) =>
    readRelease270Snapshot({
      database,
      releaseSha,
      databaseResource: EXPECTED.databaseResourceId,
      lockPid,
      trustedConsumerInventoryHash: inventoryHash,
      trustedConsumerCollectorHash: collectorHash,
      recordConsumerObservation: (receipt) => {
        observations.push(receipt)
        appendFileSync(
          path.join(output, 'consumer-observations.jsonl'),
          JSON.stringify(receipt) + '\n',
          { mode: 0o600 },
        )
      },
      readConsumers: async (request) => {
        const observedAt = new Date().toISOString()
        return {
          schema: 'torchiko-release270-consumer-observation/v1',
          challenge: request.challenge,
          requestStartedAt: request.requestStartedAt,
          observedAt,
          completedAt: observedAt,
          releaseSha,
          resource: stable.resource,
          collectorHash,
          providerRevision: `fictional-${request.challenge}`,
          evidence: { ...stable, observedAt },
        }
      },
      readQueues: () =>
        readRelease269StagingQueues({
          environment,
          releaseSha,
          preserveDormantQueues: true,
          createConnection: (_ignored, options) => new Redis(target.redis, options),
        }),
    })
  const before = await execute(target.source, (client) => snapshot(client))
  assert.equal(before.ledger.length, 269)
  await save('before269', before)
  const sourceSecurity = await execute(target.source, (client) =>
    client.$queryRawUnsafe(RESTORE_SECURITY_SQL),
  )
  await save('before269-security', sourceSecurity)
  const archive = path.join(output, 'fictional269.dump')
  const backupCreatedAt = new Date().toISOString()
  await writeFile(archive, command('pg_dump', ['-Fc'], pg(target.source)))
  const backupSha256 = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  command(
    'pg_restore',
    ['--exit-on-error', '--dbname', RESTORE_DATABASE],
    pg(target.restore),
    await readFile(archive),
  )
  const restored = await execute(target.restore, (client) => snapshot(client))
  await save('restored269', restored)
  const restoredSecurity = await execute(target.restore, (client) =>
    client.$queryRawUnsafe(RESTORE_SECURITY_SQL),
  )
  await save('restored269-security', restoredSecurity)
  const restoreEquivalence = assertRelease270RestoreEquivalent(
    before,
    restored,
    sourceSecurity,
    restoredSecurity,
  )
  const restoreProofSha256 = hashRelease270({
    backupSha256,
    cutoff: release270CutoffHash(restored),
    postgresMajor: restored.postgresMajor,
  })
  const restoreVerifiedAt = new Date().toISOString()
  await save('restore', {
    scope: 'disposable-only',
    backupSha256,
    restoreProofSha256,
    postgresMajor: restored.postgresMajor,
    backupCreatedAt,
    restoreVerifiedAt,
    restoreEquivalence,
  })
  // Reference catalog comes from unchanged source replay, not logical restore.
  migrate(target.reference, predecessor267)
  sql(target.reference, fixtureSql)
  migrate(target.reference, predecessor269)
  sql(target.reference, fixtureSql269)
  migrate(target.reference, prismaDirectory)
  const rehearsed = await execute(target.reference, (client) => snapshot(client))
  await save('rehearsed270', rehearsed)
  // Real PostgreSQL lock contention and guardian loss, isolated from mutation.
  const guardian = db(target.restore),
    contender = db(target.restore)
  try {
    await withRelease270Lock(guardian, async () => {
      await assert.rejects(
        withRelease270Lock(contender, () => assert.fail('busy lock admitted')),
        /release270-migration-lock-busy/u,
      )
    })
    await assert.rejects(
      withRelease270Lock(guardian, async (pid, guard) => {
        await contender.$queryRawUnsafe(`SELECT pg_terminate_backend(${pid}) AS terminated`)
        await assert.rejects(guard.assertHeld(), /release270-migration-lock-lost/u)
        assert.equal(guard.signal.aborted, true)
      }),
    )
  } finally {
    await Promise.allSettled([guardian.$disconnect(), contender.$disconnect()])
  }
  const proof = {
    schema: RELEASE270_STAGING_PROOF_SCHEMA,
    releaseSha,
    referenceReleaseSha: releaseSha,
    referencePostgresMajor: rehearsed.postgresMajor,
    databaseResource: EXPECTED.databaseResourceId,
    manifestHash: RELEASE270.manifestHash,
    independentRestoreVerified: true,
    backupSha256,
    restoreProofSha256,
    reference: rehearsed.catalog,
    referenceHash: release270CatalogHash(rehearsed.catalog),
    rehearsedNewSecurityHash: rehearsed.newSecurityHash,
    createdAt: new Date().toISOString(),
    queueResource: stable.resource,
    trustedConsumerInventoryHash: inventoryHash,
    trustedConsumerCollectorHash: collectorHash,
    workerFlagsHash: before.workerFlagsHash,
    beforeSnapshotHash: release270CutoffHash(before),
  }
  Object.assign(environment, {
    PATHFINDER_STAGING_BACKUP_CREATED_AT: backupCreatedAt,
    PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT: restoreVerifiedAt,
    PATHFINDER_STAGING_BACKUP_SHA256: backupSha256,
    PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256: restoreProofSha256,
  })
  await save('reference', proof)
  const reader = db(target.source),
    lock = db(target.source)
  const journal = await open(path.join(output, 'runner.jsonl'), 'wx', 0o600)
  let children = 0
  const phases = []
  const record = async (phase, evidence) => {
    phases.push(phase)
    await journal.writeFile(JSON.stringify({ phase, evidence }) + '\n')
    await journal.sync()
  }
  const inspectSource = async () => ({
    head: git('rev-parse', 'HEAD'),
    status: git('status', '--porcelain', '--untracked-files=all'),
    manifest: await readMigrationManifest(prismaDirectory),
  })
  const run = () =>
    runRelease270({
      environment,
      releaseSha,
      approval: RELEASE270_STAGING_APPROVAL,
      proof,
      inspectSource,
      readSnapshot: (pid) => snapshot(reader, pid),
      withLock: (action) => withRelease270Lock(lock, action),
      record,
      deploy: async ({ signal }) => {
        children++
        await spawnRelease270Migration({
          cli,
          prismaDirectory,
          environment: {
            ...clean,
            DATABASE_URL: target.source,
            DIRECT_DATABASE_URL: target.source,
          },
          signal,
        })
      },
    })
  try {
    const result = await run()
    assert.equal(result.changed, true)
    assert.equal(result.applicationHeld, true)
    assert.equal(children, 1)
    environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS = '0'
    assert.equal((await run()).changed, false)
    assert.equal(children, 1)
    sql(
      target.source,
      `INSERT INTO embedding_venue_refreshes(id,tenant_id,venue_id,operation_key,plan_digest,max_records,requested_by,status,before_audit)
      VALUES ('fictional-runner-unknown','fictional-release270-compatibility','compat-venue','fictional-runner-operation','fictional-digest',1,'fictional-fixture','OUTCOME_UNKNOWN','{}');`,
    )
    assert.equal((await run()).changed, false)
    assert.equal(children, 1)
    const [retained] = await reader.$queryRawUnsafe(
      "SELECT count(*)::int AS count FROM embedding_venue_refreshes WHERE id='fictional-runner-unknown' AND status='OUTCOME_UNKNOWN'",
    )
    assert.equal(retained.count, 1, 'complete rerun lost unknown-outcome receipt')
    assert.ok(phases.includes('verified') && phases.includes('verified-no-pending'))
    const [version] = await reader.$queryRawUnsafe(
      "SELECT version() AS version, current_setting('server_version_num')::int AS major",
    )
    await save('result', {
      scope: 'real-disposable-core-not-hosted-admission',
      releaseSha,
      node: process.version,
      postgres: version,
      manifestHash: manifest.hash,
      children,
      phases,
      observations,
      realLockContention: true,
      realGuardianLoss: true,
      retainedUnknownReceipt: true,
      passed: true,
    })
  } finally {
    await Promise.all([reader.$disconnect(), lock.$disconnect()])
    await journal.close()
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch(() => {
    console.error('release270-disposable-failed; inspect fictional artifacts')
    process.exitCode = 1
  })
