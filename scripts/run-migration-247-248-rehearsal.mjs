import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDisposableMigration } from './lib/disposable-prisma-migration.mjs'
import {
  FINAL_COUNT,
  NEW_ENUM_LABEL,
  PREDECESSOR,
  PREDECESSOR_COUNT,
  assertEnumTransition,
  assertLedger,
  assertOwnedPath,
  parseArgs,
  sha256,
} from './lib/migration-247-248-rehearsal.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { nativeRoot, port } = parseArgs(process.argv.slice(2))
const nonce = randomUUID().replaceAll('-', '').slice(0, 12)
const proof = path.join(nativeRoot, `proof-migration-247-248-${nonce}`)
const data = path.join(proof, 'data')
const database = `pathfinder_disposable_m248_${nonce}`
const bin = path.join(nativeRoot, 'archive', 'pgsql', 'bin')
const migration248Path = path.join(
  repo,
  'packages/db/prisma/migrations/20260911063000_add_native_venue_bot_configuration_effect/migration.sql',
)
const env = Object.fromEntries(
  ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP']
    .map((name) =>
      Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase()),
    )
    .filter(Boolean),
)
Object.assign(env, {
  PGHOST: '127.0.0.1',
  PGPORT: port,
  PGUSER: 'postgres',
  PGPASSFILE: path.join(proof, 'no-password-file'),
  PGSERVICEFILE: path.join(proof, 'no-service-file'),
  PGOPTIONS: '-c timezone=UTC -c statement_timeout=60000',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
})
const git = (...args) => spawnSync('git', args, { cwd: repo, windowsHide: true, encoding: 'utf8' })
const fail = (message) => {
  throw new Error(message)
}
const normalizeLf = (value) => Buffer.from(String(value).replaceAll('\r\n', '\n'))
const result = {
  schemaVersion: 1,
  kind: 'disposable-native-postgresql-migration-247-248',
  predecessor: PREDECESSOR,
  proof,
  database,
  port: Number(port),
  hostedAuthority: false,
  passed: false,
  stopped: false,
}
const save = () => writeFileSync(path.join(proof, 'result.json'), JSON.stringify(result, null, 2))
let sequence = 0
function run(
  label,
  executable,
  args,
  { input, allowFailure = false, cwd = proof, childEnv = env } = {},
) {
  const log = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}.log`)
  const fd = openSync(log, 'wx')
  let child
  try {
    child = spawnSync(executable, args, {
      cwd,
      env: childEnv,
      windowsHide: true,
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', fd, fd],
      timeout: 180000,
    })
  } finally {
    closeSync(fd)
  }
  const output = readFileSync(log, 'utf8')
  if (!allowFailure && (child.error || child.status !== 0)) fail(`${label} failed; inspect ${log}`)
  return { status: child.status, log, output }
}
function sql(query, label) {
  const response = run(
    label,
    path.join(bin, 'psql.exe'),
    ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database],
    { input: query },
  )
  return response.output.trim()
}
function json(query, label) {
  return JSON.parse(sql(query, label))
}
function migrationRows() {
  const row = git(
    'ls-tree',
    '-r',
    '--name-only',
    PREDECESSOR,
    '--',
    'packages/db/prisma/migrations',
  )
  if (row.status !== 0) fail('Exact 247 predecessor is unavailable.')
  const paths = row.stdout
    .split(/\r?\n/u)
    .filter((name) => name.endsWith('/migration.sql'))
    .sort()
  assert.equal(
    paths.length,
    PREDECESSOR_COUNT,
    'Exact predecessor does not contain 247 migrations.',
  )
  return paths.map((source) => {
    const bytes = git('show', `${PREDECESSOR}:${source}`)
    if (bytes.status !== 0) fail(`Cannot read predecessor migration ${source}.`)
    const current = readFileSync(path.join(repo, source))
    const predecessorBytes = Buffer.from(bytes.stdout)
    assert.equal(
      sha256(normalizeLf(current)),
      sha256(predecessorBytes),
      `Predecessor migration differs from its Git LF bytes: ${source}`,
    )
    return {
      source,
      name: source.split('/').at(-2),
      bytes: predecessorBytes,
      gitLfSha256: sha256(predecessorBytes),
      filesystemRawSha256: sha256(current),
      filesystemLfSha256: sha256(normalizeLf(current)),
    }
  })
}
function prepareSnapshot(migrations, migration248) {
  const root = path.join(proof, 'candidate-248')
  const prisma = path.join(root, 'packages', 'db', 'prisma')
  mkdirSync(path.join(prisma, 'migrations'), { recursive: true })
  writeFileSync(
    path.join(prisma, 'schema.prisma'),
    readFileSync(path.join(repo, 'packages/db/prisma/schema.prisma')),
  )
  writeFileSync(
    path.join(prisma, 'migrations', 'migration_lock.toml'),
    readFileSync(path.join(repo, 'packages/db/prisma/migrations/migration_lock.toml')),
  )
  for (const migration of [...migrations, migration248]) {
    const destination = path.join(prisma, 'migrations', migration.name)
    mkdirSync(destination)
    writeFileSync(path.join(destination, 'migration.sql'), migration.bytes)
  }
  symlinkSync(
    path.join(repo, 'packages', 'db', 'node_modules'),
    path.join(root, 'packages', 'db', 'node_modules'),
    'junction',
  )
  return root
}
function deploy(snapshot, label) {
  const logs = []
  const status = runDisposableMigration({
    argv: ['--database', database, '--confirm-database', database],
    env: {
      ...env,
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://postgres:fixture@127.0.0.1:${port}/${database}`,
    },
    repoRoot: snapshot,
    stdout: { write: (value) => logs.push(String(value)) },
    stderr: { write: (value) => logs.push(String(value)) },
  })
  const output = logs.join('')
  const log = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}.log`)
  writeFileSync(log, output)
  assert.equal(status, 0, `${label} failed; inspect ${log}`)
  return {
    log,
    outputSha256: sha256(output),
    noPending: output.includes('No pending migrations to apply'),
  }
}
function enumRows() {
  return json(
    "SELECT COALESCE(json_agg(json_build_object('label',e.enumlabel,'order',e.enumsortorder) ORDER BY e.enumsortorder),'[]') FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname='NativeVenueDeploymentEffectKind';",
    'enum-labels',
  )
}
function ledger() {
  return json(
    "SELECT COALESCE(json_agg(json_build_object('migration_name',migration_name,'checksum',checksum,'finished_at',finished_at,'rolled_back_at',rolled_back_at) ORDER BY migration_name),'[]') FROM _prisma_migrations;",
    'migration-ledger',
  )
}
function tableCount() {
  return Number(sql("SELECT count(*) FROM pg_tables WHERE schemaname='public';", 'table-count'))
}
function effectRow() {
  return json(
    "SELECT json_build_object('id',id::text,'kind',kind::text,'targetId',target_id,'beforeHash',before_hash,'afterHash',after_hash,'beforeState',before_state,'afterState',after_state) FROM native_venue_deployment_effects WHERE id='33333333-3333-4333-8333-333333333333'::uuid;",
    'effect-row',
  )
}
function seedRepresentativeEffect() {
  const hashA = 'a'.repeat(64)
  const hashB = 'b'.repeat(64)
  const sqlText = `
    INSERT INTO native_venue_deployment_artifacts(id,tenant_id,venue_id,profile,idempotency_key,canonical_manifest,manifest_hash,base_state_hash,desired_state_hash,base_universe,created_by)
    VALUES('11111111-1111-4111-8111-111111111111','mr-t1','mr-v-a','NATIVE_CORE_V1','22222222-2222-4222-8222-222222222222',
      jsonb_build_object('schemaVersion',2,'packageType','FULL','materializationProfile','NATIVE_CORE_V1','manifestId','11111111-1111-4111-8111-111111111111','idempotencyKey','22222222-2222-4222-8222-222222222222','venueRef','mr-v-a','baseState',jsonb_build_object('stateHash','${hashA}')),
      '${hashA}','${hashA}','${hashB}',jsonb_build_object('stateHash','${hashA}'),'fixture');
    INSERT INTO native_venue_deployment_releases(id,tenant_id,venue_id,artifact_id,profile,manifest_hash,base_state_hash,desired_state_hash,plan_hash,expected_effect_count,replacement_universe,plan,status,created_by,updated_at)
    VALUES('11111111-1111-4111-8111-111111111111','mr-t1','mr-v-a','11111111-1111-4111-8111-111111111111','NATIVE_CORE_V1','${hashA}','${hashA}','${hashB}','${hashA}',1,jsonb_build_object('stateHash','${hashA}'),
      jsonb_build_object('effects',jsonb_build_array(jsonb_build_object('effectOrder',1,'kind','VENUE','targetId','mr-v-a','beforeHash','${hashA}','afterHash','${hashB}','beforeState',jsonb_build_object('present',true,'value',jsonb_build_object('name','before')),'afterState',jsonb_build_object('present',true,'value',jsonb_build_object('name','after'))))),'DRAFT','fixture','2026-09-11T00:00:00.000Z');
    BEGIN;
      SET CONSTRAINTS ALL DEFERRED;
      UPDATE native_venue_deployment_releases SET status='APPROVED',approved_by='fixture',approved_at='2026-09-11T00:00:00.000Z',approved_command_id='44444444-4444-4444-8444-444444444444',approved_command_hash='${hashA}',updated_at='2026-09-11T00:00:00.000Z' WHERE id='11111111-1111-4111-8111-111111111111';
      INSERT INTO native_venue_deployment_commands(id,tenant_id,venue_id,release_id,kind,command_hash,actor_id,produced_status,produced_snapshot,created_at)
      VALUES('44444444-4444-4444-8444-444444444444','mr-t1','mr-v-a','11111111-1111-4111-8111-111111111111','APPROVE','${hashA}','fixture','APPROVED',jsonb_build_object('releaseId','11111111-1111-4111-8111-111111111111','status','APPROVED','updatedAt','2026-09-11T00:00:00.000Z'),'2026-09-11T00:00:00.000Z');
    COMMIT;
    INSERT INTO native_venue_deployment_effects(id,tenant_id,venue_id,release_id,effect_order,kind,target_id,before_hash,after_hash,before_state,after_state)
    VALUES('33333333-3333-4333-8333-333333333333','mr-t1','mr-v-a','11111111-1111-4111-8111-111111111111',1,'VENUE','mr-v-a','${hashA}','${hashB}',jsonb_build_object('present',true,'value',jsonb_build_object('name','before')),jsonb_build_object('present',true,'value',jsonb_build_object('name','after')));
  `
  sql(sqlText, 'seed-preexisting-native-effect')
}

assertOwnedPath(nativeRoot, proof)
assert(!existsSync(proof), 'Proof directory already exists.')
for (const name of ['initdb.exe', 'pg_ctl.exe', 'psql.exe', 'createdb.exe'])
  assert(existsSync(path.join(bin, name)), `Missing native PostgreSQL binary: ${name}`)
const migrations = migrationRows()
assert(existsSync(migration248Path), 'Migration 248 source is missing.')
const migration248 = {
  name: '20260911063000_add_native_venue_bot_configuration_effect',
  bytes: readFileSync(migration248Path),
}
migration248.sha256 = sha256(migration248.bytes)
migration248.lfSha256 = sha256(normalizeLf(migration248.bytes))
assert.equal(
  migration248.bytes
    .toString('utf8')
    .replace(/^\s*--.*$/gmu, '')
    .trim(),
  'ALTER TYPE "NativeVenueDeploymentEffectKind" ADD VALUE \'VENUE_BOT_CONFIGURATION\';',
  'Migration 248 must remain one additive enum statement.',
)
mkdirSync(proof)
result.predecessorMigrationManifest = migrations.map(({ bytes, ...row }) => row)
result.migration248 = {
  source: path.relative(repo, migration248Path).replaceAll('\\', '/'),
  rawSha256: migration248.sha256,
  lfSha256: migration248.lfSha256,
}
save()
let started = false
try {
  const predecessorRoot = path.join(proof, 'candidate-247')
  const predecessorPrisma = path.join(predecessorRoot, 'packages', 'db', 'prisma')
  mkdirSync(path.join(predecessorPrisma, 'migrations'), { recursive: true })
  writeFileSync(
    path.join(predecessorPrisma, 'schema.prisma'),
    readFileSync(path.join(repo, 'packages/db/prisma/schema.prisma')),
  )
  writeFileSync(
    path.join(predecessorPrisma, 'migrations', 'migration_lock.toml'),
    readFileSync(path.join(repo, 'packages/db/prisma/migrations/migration_lock.toml')),
  )
  for (const migration of migrations) {
    const destination = path.join(predecessorPrisma, 'migrations', migration.name)
    mkdirSync(destination)
    writeFileSync(path.join(destination, 'migration.sql'), migration.bytes)
  }
  symlinkSync(
    path.join(repo, 'packages', 'db', 'node_modules'),
    path.join(predecessorRoot, 'packages', 'db', 'node_modules'),
    'junction',
  )
  const finalRoot = prepareSnapshot(migrations, migration248)
  run('initdb', path.join(bin, 'initdb.exe'), [
    '-D',
    data,
    '-U',
    'postgres',
    '--auth-local=trust',
    '--auth-host=trust',
    '--encoding=UTF8',
    '--locale=C',
  ])
  run('start', path.join(bin, 'pg_ctl.exe'), [
    '-D',
    data,
    '-l',
    path.join(proof, 'postgres.log'),
    '-o',
    `-h 127.0.0.1 -p ${port} -c timezone=UTC`,
    '-w',
    'start',
  ])
  started = true
  run('createdb', path.join(bin, 'createdb.exe'), [
    '-h',
    '127.0.0.1',
    '-p',
    port,
    '-U',
    'postgres',
    database,
  ])
  result.predecessorDeploy = deploy(predecessorRoot, 'deploy-247')
  assert.equal(
    result.predecessorDeploy.noPending,
    false,
    'Initial predecessor deploy unexpectedly replayed.',
  )
  result.predecessorTables = tableCount()
  assert.equal(result.predecessorTables, 264, 'Expected retained 264-table predecessor.')
  result.enumBefore = enumRows()
  result.ledgerBefore = ledger()
  sql(
    readFileSync(path.join(repo, 'scripts/fixtures/migration-236-247/seed-236.sql'), 'utf8'),
    'seed-236',
  )
  seedRepresentativeEffect()
  result.effectBefore = effectRow()
  result.finalDeploy = deploy(finalRoot, 'deploy-248')
  result.enumAfter = enumRows()
  result.ledgerAfter = ledger()
  result.effectAfter = effectRow()
  result.finalTables = tableCount()
  assertEnumTransition(result.enumBefore, result.enumAfter)
  assertLedger(
    result.ledgerBefore,
    result.ledgerAfter,
    sha256(JSON.stringify(result.ledgerBefore)),
    migration248,
  )
  assert.equal(
    result.finalTables,
    result.predecessorTables,
    'Migration 248 changed the table count.',
  )
  assert.deepEqual(
    result.effectAfter,
    result.effectBefore,
    'Pre-existing native effect row changed.',
  )
  result.replay = deploy(finalRoot, 'deploy-248-replay')
  assert.equal(result.replay.noPending, true, 'Migration replay was not a no-op.')
  assert.deepEqual(ledger(), result.ledgerAfter, 'Replay changed migration ledger.')
  assert.deepEqual(effectRow(), result.effectBefore, 'Replay changed native effect evidence.')
  result.passed = true
} catch (error) {
  result.error = { message: error instanceof Error ? error.message : String(error) }
  process.exitCode = 1
} finally {
  if (started) {
    const stopped = run(
      'stop',
      path.join(bin, 'pg_ctl.exe'),
      ['-D', data, '-m', 'fast', '-w', 'stop'],
      { allowFailure: true },
    )
    result.stopped = stopped.status === 0
  }
  result.finishedAt = new Date().toISOString()
  save()
}
console.log(
  JSON.stringify({
    proof,
    passed: result.passed,
    stopped: result.stopped,
    error: result.error?.message,
  }),
)
