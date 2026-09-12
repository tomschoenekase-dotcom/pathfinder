// Explicit local synthetic fixture only. Never accepts a database URL or hosted target.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runDisposableMigration } from './lib/disposable-prisma-migration.mjs'
import {
  EXPECTED,
  assertFrozenManifest,
  readMigrationManifest,
  ledgerState,
  remainingMigrationNames,
} from './run-staging-migration-predeploy.mjs'
import {
  assertPreserved,
  FINAL_MIGRATION,
  quoteIdentifier as qi,
  sha256,
} from './lib/migration-248-249-rehearsal.mjs'

const args = process.argv.slice(2)
assert.equal(args.length, 6, 'Require --proof-root --container-id --port pairs')
const options = {}
for (let i = 0; i < args.length; i += 2) {
  assert(['--proof-root', '--container-id', '--port'].includes(args[i]) && !options[args[i]])
  options[args[i]] = args[i + 1]
}
assert(path.isAbsolute(options['--proof-root']))
assert(/^[a-f0-9]{64}$/.test(options['--container-id']))
const port = Number(options['--port'])
assert(Number.isInteger(port) && port >= 49152 && port <= 65535)
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.resolve(options['--proof-root'])
const nonce = randomUUID().replaceAll('-', '').slice(0, 12)
const proof = path.join(root, `proof-248-249-${nonce}`)
mkdirSync(proof, { recursive: false })
const database = `pathfinder_disposable_guest_lifecycle_upgrade_${nonce}`
const container = options['--container-id']
const env = Object.fromEntries(
  [
    'SystemRoot',
    'WINDIR',
    'ComSpec',
    'USERPROFILE',
    'LOCALAPPDATA',
    'APPDATA',
    'PATH',
    'TEMP',
    'TMP',
  ]
    .map((key) => [key, process.env[key]])
    .filter(([, value]) => value),
)
const result = {
  kind: 'SYNTHETIC-POPULATED-248-249-ONLY',
  database,
  container,
  port,
  proof,
  passed: false,
  closed: false,
  hostedAuthority: false,
  commands: [],
}
const save = () => writeFileSync(path.join(proof, 'result.json'), JSON.stringify(result, null, 2))
let sequence = 0
function run(label, executable, argv, input) {
  const prefix = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}`)
  const startedUtc = new Date().toISOString()
  const child = spawnSync(executable, argv, {
    cwd: repo,
    env,
    input,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  })
  const record = {
    command: [executable, ...argv],
    startedUtc,
    completedUtc: new Date().toISOString(),
    exitCode: child.status,
    logs: [],
  }
  for (const [stream, text] of [
    ['stdout', child.stdout ?? ''],
    ['stderr', child.stderr ?? ''],
  ]) {
    const file = `${prefix}.${stream}.log`
    writeFileSync(file, text, { flag: 'wx' })
    record.logs.push({ path: file, sha256: sha256(text) })
  }
  writeFileSync(`${prefix}.json`, JSON.stringify(record, null, 2), { flag: 'wx' })
  result.commands.push(`${prefix}.json`)
  save()
  assert(!child.error && child.status === 0, `${label} failed; no retry`)
  return child.stdout
}
function sql(label, query, target = database) {
  writeFileSync(path.join(proof, `${String(sequence + 1).padStart(3, '0')}-${label}.sql`), query, {
    flag: 'wx',
  })
  return run(
    label,
    'docker',
    [
      '--context',
      'desktop-linux',
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '--no-psqlrc',
      '-qAt',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'postgres',
      '-d',
      target,
    ],
    `SET statement_timeout='60s'; SET lock_timeout='5s'; SET timezone='UTC';\n${query}`,
  )
}
const parseLines = (text) =>
  text
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
const ledgerQuery = `SELECT coalesce(json_agg(to_jsonb(m) ORDER BY migration_name),'[]') FROM public._prisma_migrations m;`
function deploy(snapshot, label) {
  const streams = { stdout: '', stderr: '' }
  const startedUtc = new Date().toISOString()
  const status = runDisposableMigration({
    argv: ['--database', database, '--confirm-database', database],
    env: {
      ...env,
      PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1',
      PATHFINDER_DISPOSABLE_DATABASE_URL: `postgresql://postgres:synthetic-fixture-only@127.0.0.1:${port}/${database}`,
    },
    repoRoot: snapshot,
    spawnSyncImpl: (cmd, argv, opts) => spawnSync(cmd, argv, { ...opts, timeout: 180000 }),
    stdout: {
      write: (value) => {
        streams.stdout += value
      },
    },
    stderr: {
      write: (value) => {
        streams.stderr += value
      },
    },
  })
  const prefix = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}`)
  for (const [name, text] of Object.entries(streams))
    writeFileSync(`${prefix}.${name}.log`, text, { flag: 'wx' })
  writeFileSync(
    `${prefix}.json`,
    JSON.stringify(
      {
        kind: 'existing-guarded-disposable-migration',
        snapshot,
        database,
        startedUtc,
        completedUtc: new Date().toISOString(),
        exitCode: status,
        stdoutSha256: sha256(streams.stdout),
        stderrSha256: sha256(streams.stderr),
      },
      null,
      2,
    ),
    { flag: 'wx' },
  )
  result.commands.push(`${prefix}.json`)
  save()
  assert.equal(status, 0, `${label} failed; no resolve/retry`)
  return streams.stdout
}
function snapshot(count, manifest) {
  const out = path.join(proof, `source-${count}`)
  const prisma = path.join(out, 'packages/db/prisma')
  mkdirSync(path.join(prisma, 'migrations'), { recursive: true })
  for (const file of ['schema.prisma', 'migrations/migration_lock.toml'])
    writeFileSync(
      path.join(prisma, file),
      readFileSync(path.join(repo, 'packages/db/prisma', file)),
    )
  for (const name of manifest.names.slice(0, count)) {
    mkdirSync(path.join(prisma, 'migrations', name))
    writeFileSync(
      path.join(prisma, 'migrations', name, 'migration.sql'),
      readFileSync(path.join(repo, 'packages/db/prisma/migrations', name, 'migration.sql')),
    )
  }
  symlinkSync(
    path.join(repo, 'packages/db/node_modules'),
    path.join(out, 'packages/db/node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  return out
}
let created = false
try {
  const info = JSON.parse(
    run('container-identity', 'docker', [
      '--context',
      'desktop-linux',
      'inspect',
      '--format',
      '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},"Running":{{json .State.Running}},"Ports":{{json .NetworkSettings.Ports}}}',
      container,
    ]),
  )
  assert.equal(info.Id, container)
  assert(info.Name.startsWith('/pathfinder-disposable-guest-lifecycle-'))
  assert.equal(
    info.Image,
    'sha256:40b404964359299eefdd5f8518facf1886c562848cf4de13b6eaf91cb70c2b87',
  )
  assert.equal(info.Running, true)
  assert.deepEqual(info.Ports['5432/tcp'], [{ HostIp: '127.0.0.1', HostPort: String(port) }])
  const manifest = await readMigrationManifest(path.join(repo, 'packages/db/prisma'))
  assertFrozenManifest(manifest)
  assert.equal(EXPECTED.migrationCount, 249)
  assert.equal(EXPECTED.guestDispositionPredecessorCount, 248)
  result.manifest = {
    hash: manifest.hash,
    sources: manifest.names.map((name) => ({
      name,
      rawSha256: manifest.ledgerChecksums.get(name),
      normalizedLfSha256: manifest.checksums.get(name),
    })),
  }
  save()
  const prior = snapshot(248, manifest)
  const final = snapshot(249, manifest)
  sql('create-owned-database', `CREATE DATABASE ${qi(database)};`, 'postgres')
  created = true
  assert(!deploy(prior, 'install-248').includes('No pending migrations to apply'))
  sql(
    'seed-retained-multitenant-evidence',
    readFileSync(path.join(repo, 'scripts/fixtures/migration-236-247/seed-236.sql'), 'utf8'),
  )
  sql(
    'seed-guest-content',
    `BEGIN;
    UPDATE visitor_sessions SET visitor_id='synthetic-persistent-visitor',latest_lat=41,latest_lng=-87 WHERE id='mr-session-a';
    INSERT INTO messages(id,tenant_id,venue_id,session_id,session_sequence,role,content,topic,created_at) VALUES
      ('upgrade-message-a','mr-t1','mr-v-a','mr-session-a',1,'user','Synthetic preserved question','directions','2025-01-01'),
      ('upgrade-message-b','mr-t1','mr-v-a','mr-session-a',2,'assistant','Synthetic preserved answer','directions','2025-01-01');
    INSERT INTO analytics_events(id,tenant_id,venue_id,session_id,event_type,metadata,occurred_at) VALUES('upgrade-event','mr-t1','mr-v-a','mr-session-a','message.received','{"synthetic":"preserve"}','2025-01-01');
    COMMIT;`,
  )
  const columns = JSON.parse(
    sql(
      'old-column-catalogue',
      `SELECT json_agg(x ORDER BY table_name) FROM (SELECT table_name,array_agg(column_name ORDER BY ordinal_position) columns FROM information_schema.columns WHERE table_schema='public' AND table_name<>'_prisma_migrations' GROUP BY table_name) x;`,
    ),
  )
  assert.equal(columns.length, 263)
  const sequenceNames = JSON.parse(
    sql(
      'sequence-names',
      `SELECT coalesce(json_agg(sequencename ORDER BY sequencename),'[]') FROM pg_sequences WHERE schemaname='public';`,
    ),
  )
  const observe = (label, complete) => {
    const rowSql = columns
      .map(
        ({ table_name, columns: fields }) =>
          `SELECT json_build_object('table',${JSON.stringify(table_name).replaceAll('"', "'")},'count',count(*),'sha256',encode(sha256(convert_to(coalesce(string_agg(h,'' ORDER BY h),''),'UTF8')),'hex')) FROM (SELECT encode(sha256(convert_to(row_to_json(t)::text,'UTF8')),'hex') h FROM (SELECT ${fields.map(qi).join(',')} FROM public.${qi(table_name)}) t) r;`,
      )
      .join('\n')
    const rows = parseLines(
      sql(`${label}-rows`, `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;${rowSql}COMMIT;`),
    )
    const sequences = sequenceNames.length
      ? parseLines(
          sql(
            `${label}-sequences`,
            sequenceNames
              .map(
                (name) =>
                  `SELECT json_build_object('name','${name.replaceAll("'", "''")}','state',(SELECT json_build_object('last_value',last_value,'is_called',is_called,'log_cnt',log_cnt) FROM public.${qi(name)}),'properties',(SELECT to_jsonb(s) FROM pg_sequences s WHERE schemaname='public' AND sequencename='${name.replaceAll("'", "''")}'));`,
              )
              .join('\n'),
          ),
        )
      : []
    const ledger = JSON.parse(sql(`${label}-ledger`, ledgerQuery))
    const integrity = JSON.parse(
      sql(
        `${label}-integrity`,
        `SELECT json_build_object('tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT i.indisvalid),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public' AND NOT convalidated)${complete ? ",'newOperations',(SELECT count(*) FROM guest_conversation_disposition_operations),'nonNullDisposition',(SELECT count(*) FROM visitor_sessions WHERE disposition_operation_id IS NOT NULL)" : ''});`,
      ),
    )
    return { rows, sequences, ledger, ...integrity }
  }
  result.before = observe('before', false)
  assert.equal(ledgerState(result.before.ledger, manifest), 'guest-disposition-predecessor')
  assert.deepEqual(remainingMigrationNames(result.before.ledger, manifest), [FINAL_MIGRATION])
  save()
  result.advanceOutput = deploy(final, 'advance-249')
  assert(!result.advanceOutput.includes('No pending migrations to apply'))
  result.after = observe('after', true)
  assert.equal(ledgerState(result.after.ledger, manifest), 'complete')
  assertPreserved(result.before, result.after)
  assert(deploy(final, 'replay-249').includes('No pending migrations to apply'))
  result.replay = observe('replay', true)
  assert.deepEqual(result.replay, result.after)
  result.refusals = []
  for (const [name, update, reason] of [
    ['divergent', "checksum=repeat('0',64)", /checksum mismatches/u],
    ['failed', 'finished_at=NULL', /unfinished migration/u],
    ['rolled-back', 'rolled_back_at=clock_timestamp()', /rolled-back migration/u],
    ['logs', "logs='synthetic failure'", /logs are non-empty/u],
  ]) {
    const rows = JSON.parse(
      sql(
        `refusal-${name}`,
        `BEGIN; UPDATE _prisma_migrations SET ${update} WHERE migration_name='${FINAL_MIGRATION}';${ledgerQuery}ROLLBACK;`,
      ),
    )
    assert.throws(() => remainingMigrationNames(rows, manifest), reason)
    result.refusals.push(name)
  }
  assert.deepEqual(JSON.parse(sql('final-ledger', ledgerQuery)), result.after.ledger)
  result.passed = true
} catch (error) {
  result.error = String(error)
  throw error
} finally {
  if (created) {
    sql(
      'close-owned-database',
      `ALTER DATABASE ${qi(database)} ALLOW_CONNECTIONS false;`,
      'postgres',
    )
    const closed = JSON.parse(
      sql(
        'closed-readback',
        `SELECT json_build_object('database',datname,'closed',NOT datallowconn,'clients',(SELECT count(*) FROM pg_stat_activity WHERE datid=d.oid),'prepared',(SELECT count(*) FROM pg_prepared_xacts WHERE database=d.datname)) FROM pg_database d WHERE datname='${database}';`,
        'postgres',
      ),
    )
    result.finalAdmission = closed
    result.closed = closed.closed && closed.clients === 0 && closed.prepared === 0
    assert(result.closed)
  }
  save()
}
process.stdout.write(
  `${JSON.stringify({ proof, passed: result.passed, closed: result.closed, scope: result.kind })}\n`,
)
