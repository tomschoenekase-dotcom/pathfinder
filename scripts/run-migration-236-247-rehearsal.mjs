import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, openSync, closeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'node:net'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runDisposableMigration } from './lib/disposable-prisma-migration.mjs'
import { parseArgs, sha256, assertManifest, assertOwnedPath, assertPreserved, assertSuccessfulResult, manifestHash } from './lib/migration-236-247-rehearsal.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArgs(process.argv.slice(2))
const { candidate, nativeRoot, port } = options
const nonce = randomUUID().replaceAll('-', '').slice(0, 12)
const proof = path.join(nativeRoot, `proof-migration-236-247-${nonce}`)
assertOwnedPath(nativeRoot, proof)
const data = path.join(proof, 'data')
const bin = path.join(nativeRoot, 'archive/pgsql/bin')
const env = {}
for (const key of ['SystemRoot', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP']) {
  const entry = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())
  if (entry) env[key] = entry[1]
}
Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: port, PGUSER: 'postgres', PGPASSFILE: path.join(proof, 'no-password-file'), PGSERVICEFILE: path.join(proof, 'no-service-file'), PGOPTIONS: '-c timezone=UTC -c statement_timeout=60000', NO_COLOR: '1', FORCE_COLOR: '0' })
const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, maxBuffer: 30 * 1024 * 1024 })
assert.equal(git('rev-parse', `${candidate}^{commit}`).toString().trim(), candidate, 'Selected candidate must be an exact existing commit')
const observedHeadAtStart = git('rev-parse', 'HEAD').toString().trim()
const migrationPaths = git('ls-tree', '-r', '--name-only', candidate, '--', 'packages/db/prisma/migrations').toString().trim().split(/\r?\n/).filter(name => name.endsWith('/migration.sql')).sort()
assert.equal(git('diff', '--name-only', candidate, '--', ...migrationPaths).toString().trim(), '', 'Migration source differs from candidate')
const migrations = migrationPaths.map(source => {
  const bytes = git('show', `${candidate}:${source}`)
  const raw = readFileSync(path.join(repo, source))
  return { source, name: source.split('/').at(-2), bytes, gitSha256: sha256(bytes), filesystemSha256: sha256(raw), normalizedSha256: sha256(bytes.toString().replaceAll('\r\n', '\n')) }
})
assertManifest(migrations)
for (const executable of ['initdb.exe', 'pg_ctl.exe', 'psql.exe', 'createdb.exe', 'pg_dump.exe', 'pg_restore.exe']) assert(existsSync(path.join(bin, executable)), `Missing native binary ${executable}`)
assert(!existsSync(proof))
mkdirSync(proof)
const ownedSources = ['scripts/run-migration-236-247-rehearsal.mjs', 'scripts/lib/migration-236-247-rehearsal.mjs', 'scripts/lib/disposable-prisma-migration.mjs', 'scripts/fixtures/migration-236-247/seed-236.sql', 'scripts/fixtures/migration-236-247/seed-245.sql', 'scripts/fixtures/migration-236-247/seed-245-contradiction.sql']
const sourceManifest = ownedSources.map(source => {
  const bytes = readFileSync(path.join(repo, source))
  writeFileSync(path.join(proof, `source-${source.replaceAll('/', '__')}`), bytes)
  return { source, sha256: sha256(bytes) }
})
const result = { schemaVersion: 1, candidate, migrationCandidate: candidate, candidateTree: git('rev-parse', `${candidate}^{tree}`).toString().trim(), dependencyLockSha256: sha256(git('show', `${candidate}:pnpm-lock.yaml`)), proof, port, data, startedAt: new Date().toISOString(), backend: 'native-local-postgresql', sourceManifest, migrationManifest: migrations.map(({ bytes, ...row }) => row), chainSha256: manifestHash(migrations), cases: {}, stopped: false, passed: false, hostedAdmission: false, hostedRecovery: 'BLOCKED: actual operator, target backup and authorized provider restore procedure not supplied' }
result.nativeBinaryManifest = ['initdb.exe', 'pg_ctl.exe', 'psql.exe', 'createdb.exe', 'pg_dump.exe', 'pg_restore.exe'].map(name => ({ name, sha256: sha256(readFileSync(path.join(bin, name))) }))
const save = () => writeFileSync(path.join(proof, 'result.json'), JSON.stringify(result, null, 2))
result.observedHeadAtStart = observedHeadAtStart
writeFileSync(path.join(proof, 'ownership.json'), JSON.stringify({ proof, data, port, owner: 'migration-review', candidate, createdAt: result.startedAt }, null, 2))
save()
let sequence = 0
function run(label, executable, args, { allowFailure = false, input, cwd = proof, childEnv = env } = {}) {
  const start = performance.now()
  const log = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}.log`)
  const fd = openSync(log, 'wx')
  let child
  try { child = spawnSync(executable, args, { cwd, env: childEnv, windowsHide: true, encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', fd, fd], timeout: 180000 }) }
  finally { closeSync(fd) }
  const output = readFileSync(log, 'utf8')
  if (!allowFailure) assert(!child.error && child.status === 0, `${label} failed (${child.status}); ${log}`)
  return { status: child.status, stdout: output, output, log, elapsedMs: Math.round(performance.now() - start) }
}
function sql(database, query, label = 'query', allowFailure = false) {
  assert(/^pathfinder_disposable_m247_[a-z]+_[a-f0-9]{12}$/.test(database), 'Unexpected fixture database')
  return run(label, path.join(bin, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database], { input: query, allowFailure })
}
const jsonQuery = (database, query, label) => JSON.parse(sql(database, query, label).stdout.trim())
function snapshot(database, label) {
  const tables = jsonQuery(database, "SELECT json_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations';", 'table-names')
  for (const table of tables) assert(/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table))
  const query = `SELECT jsonb_object_agg(name, rows) FROM (${tables.map(table => `SELECT '${table}' AS name, COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM public."${table}" t),'[]'::jsonb) AS rows`).join(' UNION ALL ')}) all_rows;`
  const rows = jsonQuery(database, query, `snapshot-${label}`)
  writeFileSync(path.join(proof, `${database}-${label}.json`), JSON.stringify(rows, null, 2))
  return rows
}
function schemaSnapshot(database) {
  return jsonQuery(database, `SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name,ordinal_position) FROM information_schema.columns c WHERE table_schema='public'),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,c.conrelid::regclass::text,pg_get_constraintdef(c.oid)) ORDER BY c.conname,c.conrelid::regclass::text) FROM pg_constraint c WHERE c.connamespace='public'::regnamespace),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgrelid::regclass::text,t.tgname) FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)),
    'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.proname,p.oid) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f')
  );`, 'schema-snapshot')
}
function ledger(database) {
  return jsonQuery(database, 'SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY migration_name),\'[]\') FROM _prisma_migrations m;', 'ledger')
}
function topology(database, count) {
  const rows = ledger(database)
  assert.equal(rows.length, count)
  rows.forEach((row, index) => {
    assert.equal(row.migration_name, migrations[index].name)
    assert.equal(row.checksum, migrations[index].gitSha256)
    assert(row.finished_at && row.rolled_back_at === null && !row.logs)
  })
  const observed = jsonQuery(database, `SELECT jsonb_build_object('tables',(SELECT count(*) FROM pg_tables WHERE schemaname='public'),'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace='public'::regnamespace AND NOT indisvalid),'unvalidatedConstraints',(SELECT count(*) FROM pg_constraint WHERE connamespace='public'::regnamespace AND NOT convalidated));`, 'topology')
  assert.equal(observed.tables, { 236: 256, 245: 262, 247: 264 }[count])
  assert.equal(observed.invalidIndexes, 0); assert.equal(observed.unvalidatedConstraints, 0)
  return { count, ...observed, ledgerSha256: sha256(JSON.stringify(rows)) }
}
const snapshots = new Map()
function migrationSnapshot(count) {
  if (snapshots.has(count)) return snapshots.get(count)
  const root = path.join(proof, `candidate-${count}`)
  const prisma = path.join(root, 'packages/db/prisma')
  mkdirSync(path.join(prisma, 'migrations'), { recursive: true })
  writeFileSync(path.join(prisma, 'schema.prisma'), git('show', `${candidate}:packages/db/prisma/schema.prisma`))
  writeFileSync(path.join(prisma, 'migrations/migration_lock.toml'), git('show', `${candidate}:packages/db/prisma/migrations/migration_lock.toml`))
  for (const row of migrations.slice(0, count)) {
    const directory = path.join(prisma, 'migrations', row.name)
    mkdirSync(directory)
    writeFileSync(path.join(directory, 'migration.sql'), row.bytes)
    assert.equal(sha256(readFileSync(path.join(directory, 'migration.sql'))), row.gitSha256)
  }
  symlinkSync(path.join(repo, 'packages/db/node_modules'), path.join(root, 'packages/db/node_modules'), 'junction')
  snapshots.set(count, root)
  return root
}
function deploy(database, count, expectedSuccess = true) {
  const logs = []
  const url = `postgresql://postgres:fixture@127.0.0.1:${port}/${database}`
  const start = performance.now()
  const status = runDisposableMigration({ argv: ['--database', database, '--confirm-database', database], env: { ...env, PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1', PATHFINDER_DISPOSABLE_DATABASE_URL: url }, repoRoot: migrationSnapshot(count), stdout: { write: text => logs.push(String(text)) }, stderr: { write: text => logs.push(String(text)) } })
  const output = logs.join('')
  const log = path.join(proof, `${String(++sequence).padStart(3, '0')}-deploy-${database}-${count}.log`)
  writeFileSync(log, output)
  assert.equal(status === 0, expectedSuccess, `Unexpected deploy result; ${log}`)
  return { status, log, elapsedMs: Math.round(performance.now() - start), outputSha256: sha256(output), noPending: output.includes('No pending migrations to apply') }
}
function asynchronousProcess(label, executable, args, childEnv = env) {
  const log = path.join(proof, `${String(++sequence).padStart(3, '0')}-${label}.log`)
  const fd = openSync(log, 'wx')
  const start = performance.now()
  const child = spawn(executable, args, { cwd: proof, env: childEnv, windowsHide: true, stdio: ['pipe', fd, fd], timeout: 90000 })
  const done = new Promise(resolve => {
    let error
    child.once('error', value => { error = value.message })
    child.once('close', status => { closeSync(fd); resolve({ status, error, log, output: readFileSync(log, 'utf8'), elapsedMs: Math.round(performance.now() - start) }) })
  })
  return { child, done }
}
function session(database, label) {
  return asynchronousProcess(label, path.join(bin, 'psql.exe'), ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database], { ...env, PGAPPNAME: `m247_${nonce}_${label}` })
}
async function observe(database, query, predicate, label) {
  const deadline = performance.now() + 15000
  while (performance.now() < deadline) {
    const value = jsonQuery(database, query, label)
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  throw new Error(`Did not observe ${label} before bounded deadline`)
}
async function lockObservedDeploy(database) {
  const holder = session(database, 'migration-holder')
  let migrating
  try {
    holder.child.stdin.write('BEGIN; LOCK TABLE knowledge_change_proposals IN ROW EXCLUSIVE MODE; SELECT 1;\n')
    const holderState = await observe(database, `SELECT COALESCE(json_agg(json_build_object('pid',pid,'state',state)),'[]') FROM pg_stat_activity WHERE application_name='m247_${nonce}_migration-holder' AND state='idle in transaction';`, rows => rows.length === 1, 'migration-holder-ready')
    const snapshotRoot = migrationSnapshot(247)
    const childPath = path.join(proof, 'wrapper-child.mjs')
    const source = `import { runDisposableMigration } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/lib/disposable-prisma-migration.mjs')).href)};\nprocess.exitCode = runDisposableMigration({argv: ${JSON.stringify(['--database', database, '--confirm-database', database])}, env: process.env, repoRoot: ${JSON.stringify(snapshotRoot)}});\n`
    writeFileSync(childPath, source)
    const url = `postgresql://postgres:fixture@127.0.0.1:${port}/${database}`
    migrating = asynchronousProcess('observed-canonical-deploy', process.execPath, [childPath], { ...env, PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1', PATHFINDER_DISPOSABLE_DATABASE_URL: url })
    migrating.child.stdin.end()
    const started = performance.now()
    const waiting = await observe(database, `SELECT COALESCE(json_agg(json_build_object('pid',pid,'waitType',wait_event_type,'waitEvent',wait_event,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE datname='${database}' AND wait_event_type='Lock' AND query LIKE '%LOCK TABLE "knowledge_change_proposals"%';`, rows => rows.length === 1 && rows[0].blockers.includes(holderState[0].pid), 'migration-lock-wait')
    holder.child.stdin.end('ROLLBACK;\n')
    const held = await holder.done
    assert.equal(held.status, 0)
    const deployed = await migrating.done
    assert.equal(deployed.status, 0, `Observed canonical migration failed; ${deployed.log}`)
    return { ...deployed, output: undefined, holderPid: holderState[0].pid, waiting, waitObservationToCompletionMs: Math.round(performance.now() - started), wrapperChildSha256: sha256(source), guarantee: 'Local controlled blocking observation only; not a hosted duration guarantee' }
  } finally {
    if (!holder.child.stdin.destroyed) holder.child.stdin.end('ROLLBACK;\n')
    await holder.done
    if (migrating) await migrating.done
  }
}
async function concurrentOutcomeAssertions(database) {
  const records = []
  for (const [isolation, scopeSuffix] of [['READ COMMITTED','a'],['REPEATABLE READ','b']]) {
    const proposalExpression = `md5('race-${scopeSuffix}')::uuid`
    const holder = session(database, `race-holder-${scopeSuffix}`)
    const contenders = []
    try {
      sql(database, `INSERT INTO operational_updates(id,tenant_id,venue_id,severity,title,body,expires_at,created_by,updated_at) VALUES('mr-race-update-${scopeSuffix}','mr-t1','mr-v-${scopeSuffix}','WARNING','Synthetic race','Exclusivity probe','2099-01-01','fixture',CURRENT_TIMESTAMP);`, 'race-parent')
      const content = `INSERT INTO knowledge_proposal_operational_update_handoffs(tenant_id,venue_id,proposal_id,operational_update_id,preview_hash,created_by) VALUES('mr-t1','mr-v-${scopeSuffix}',${proposalExpression},'mr-race-update-${scopeSuffix}',repeat('a',64),'fixture');`
      const duplicate = `INSERT INTO semantic_duplicate_resolutions(id,tenant_id,venue_id,proposal_id,proposal_updated_at,preview_hash,target_knowledge_entry_id,target_snapshot_hash,input_hash,relation,desired,source_evidence,resolution_note,created_by) VALUES(md5('race-duplicate-${scopeSuffix}')::uuid,'mr-t1','mr-v-${scopeSuffix}',${proposalExpression},'2026-09-01 12:00:00.123',repeat('a',64),'mr-knowledge-${scopeSuffix}',repeat('b',64),repeat('c',64),'NEW_FACT','{}','[{"sourceId":"synthetic-race"}]','Independent valid duplicate','fixture');`
      // Each contender must succeed independently before one-winner evidence counts.
      sql(database, `BEGIN; ${content} SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`, 'content-contender-valid')
      sql(database, `BEGIN; ${duplicate} SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`, 'duplicate-contender-valid')
      holder.child.stdin.write(`BEGIN; SELECT id FROM knowledge_change_proposals WHERE id=${proposalExpression} FOR UPDATE;\n`)
      const held = await observe(database, `SELECT COALESCE(json_agg(pid),'[]') FROM pg_stat_activity WHERE application_name='m247_${nonce}_race-holder-${scopeSuffix}' AND state='idle in transaction';`, rows => rows.length === 1, 'race-holder-ready')
      for (const [kind, query] of [['content',content],['duplicate',duplicate]]) {
        const contender = session(database, `race-${scopeSuffix}-${kind}`)
        contenders.push({ kind, ...contender })
        contender.child.stdin.end(`BEGIN ISOLATION LEVEL ${isolation}; SELECT id FROM knowledge_change_proposals WHERE id=${proposalExpression}; ${query} COMMIT;\n`)
      }
      const waiters = await observe(database, `SELECT COALESCE(json_agg(json_build_object('pid',pid,'applicationName',application_name,'waitType',wait_event_type,'blockers',pg_blocking_pids(pid))),'[]') FROM pg_stat_activity WHERE application_name IN ('m247_${nonce}_race-${scopeSuffix}-content','m247_${nonce}_race-${scopeSuffix}-duplicate') AND wait_event_type='Lock';`, rows => rows.length === 2, 'race-waiters')
      holder.child.stdin.end('ROLLBACK;\n')
      assert.equal((await holder.done).status, 0)
      const outcomes = await Promise.all(contenders.map(async contender => ({ kind: contender.kind, ...await contender.done })))
      assert.equal(outcomes.filter(row => row.status === 0).length, 1, 'Exactly one valid terminal outcome may win')
      const loser = outcomes.find(row => row.status !== 0)
      assert.match(loser.output, /incompatible outcome claim|could not serialize access/, 'Failure must be arbitration or serialization')
      const outcome = jsonQuery(database, `SELECT jsonb_build_object('claim',(SELECT outcome_kind FROM semantic_proposal_outcome_claims WHERE proposal_id=${proposalExpression}),'content',(SELECT count(*) FROM knowledge_proposal_operational_update_handoffs WHERE proposal_id=${proposalExpression}),'duplicate',(SELECT count(*) FROM semantic_duplicate_resolutions WHERE proposal_id=${proposalExpression}));`, 'race-outcome')
      assert.equal(outcome.content + outcome.duplicate, 1)
      assert.equal(outcome.claim, outcome.content ? 'CONTENT' : 'DUPLICATE')
      records.push({ isolation, holderPid: held[0], waiters, independentlyValid: true, outcomes: outcomes.map(({ output, ...row }) => ({ ...row, outputSha256: sha256(output) })), outcome })
    } finally {
      if (!holder.child.stdin.destroyed) holder.child.stdin.end('ROLLBACK;\n')
      await holder.done
      for (const contender of contenders) await contender.done
    }
  }
  const beforeReplay = snapshot(database, 'post-race')
  const replay = deploy(database, 247)
  assert(replay.noPending)
  assertPreserved(beforeReplay, snapshot(database, 'post-race-replay'))
  return { records, replay }
}
function createDatabase(kind) {
  const name = `pathfinder_disposable_m247_${kind}_${nonce}`
  run(`createdb-${kind}`, path.join(bin, 'createdb.exe'), ['-h', '127.0.0.1', '-p', port, '-U', 'postgres', name])
  const identity = jsonQuery(name, "SELECT json_build_object('database',current_database(),'directory',current_setting('data_directory'),'port',inet_server_port());", 'database-identity')
  assert.equal(identity.database, name); assert.equal(identity.port, Number(port)); assert.equal(path.resolve(identity.directory), path.resolve(data))
  return name
}
function seed(database, phase) {
  return sql(database, readFileSync(path.join(repo, `scripts/fixtures/migration-236-247/seed-${phase}.sql`), 'utf8'), `seed-${phase}`)
}
function predecessor(database, critical = false) {
  const prefix = deploy(database, 236)
  const initial = topology(database, 236)
  initial.engine = jsonQuery(database, "SELECT jsonb_build_object('version',version(),'serverVersion',current_setting('server_version'),'timezone',current_setting('timezone'),'extensions',(SELECT jsonb_agg(jsonb_build_object('name',extname,'version',extversion) ORDER BY extname) FROM pg_extension));", 'engine-identity')
  seed(database, '236')
  const base = snapshot(database, '236-populated')
  assert(base.tenants.length >= 2 && base.venues.length >= 3 && base.conversation_insights.length >= 3)
  if (!critical) return { prefix, initial, base }
  const suffix = deploy(database, 245)
  topology(database, 245)
  const preserved = assertPreserved(base, snapshot(database, '245-before-seed'))
  seed(database, '245')
  return { prefix, initial, suffix, preserved, base: snapshot(database, '245-populated') }
}
function expectedFailure(database, label, query, pattern) {
  const response = sql(database, `BEGIN; ${query}; SET CONSTRAINTS ALL IMMEDIATE; ROLLBACK;`, label, true)
  assert.notEqual(response.status, 0, `Negative assertion did not fail: ${label}`)
  assert.match(response.output, pattern, `Unexpected failure cause: ${label}`)
  return { label, log: response.log }
}
function credentialProbeSql(capabilities, { kind = 'MCP', receipt = true, enabled = false } = {}) {
  for (const capability of capabilities) assert(/^[a-z-]+:[a-z-]+$/.test(capability))
  assert(['MCP', 'PARTNER_READ_API'].includes(kind))
  return `INSERT INTO external_access_credentials(id,tenant_id,client_id,venue_id,scope_key,kind,label,capabilities,secret_prefix,secret_hash,enabled,created_by,created_at,updated_at)
    VALUES('mr-probe-credential','mr-t1','mr-t1','mr-v-a','mr-v-a','${kind}','Unusable synthetic probe',ARRAY[${capabilities.map(value => `'${value}'`).join(',')}]::text[],'fixture-probe','$argon2id$not-a-real-credential',${enabled},'fixture',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    ${receipt ? "INSERT INTO external_credential_operation_receipts(operation_id,operation_hash,operation_kind,tenant_id,client_id,venue_id,scope_key,credential_id,actor_id,created_at) VALUES(md5('probe-credential')::uuid,repeat('a',64),'ISSUE','mr-t1','mr-t1','mr-v-a','mr-v-a','mr-probe-credential','fixture',CURRENT_TIMESTAMP);" : ''}`
}
function capabilityAssertions(database) {
  const catalogSource = git('show', `${candidate}:packages/contracts/src/mcp-v0.ts`).toString()
  const catalogBlock = catalogSource.match(/export const McpCapability = z.enum\(\[([\s\S]*?)\]\)/)?.[1]
  assert(catalogBlock, 'Candidate capability catalog missing')
  const capabilities = [...catalogBlock.matchAll(/'([a-z-]+:[a-z-]+)'/g)].map(match => match[1]).sort()
  assert(capabilities.includes('characters:build') && capabilities.includes('characters:execute') && capabilities.includes('intake-source:read'))
  const batches = []
  for (let offset = 0; offset < capabilities.length; offset += 25) {
    const batch = capabilities.slice(offset, offset + 25)
    const observed = jsonQuery(database, `BEGIN; ${credentialProbeSql(batch)} SET CONSTRAINTS ALL IMMEDIATE; SELECT jsonb_build_object('enabled',enabled,'capabilities',capabilities) FROM external_access_credentials WHERE id='mr-probe-credential'; ROLLBACK;`, 'valid-credential-catalog')
    assert.deepEqual(observed, { enabled: false, capabilities: batch }); batches.push(batch)
  }
  return { catalogSha256: sha256(catalogSource), capabilities, batches, negatives: [
    expectedFailure(database, 'credential-unknown', credentialProbeSql(['unknown:privilege']), /unsupported MCP credential capability/),
    expectedFailure(database, 'credential-partner', credentialProbeSql(['characters:build'], { kind: 'PARTNER_READ_API' }), /unsupported partner credential capability/),
    expectedFailure(database, 'credential-unsorted', credentialProbeSql(['characters:execute','characters:build']), /sorted and unique/),
    expectedFailure(database, 'credential-duplicate', credentialProbeSql(['characters:build','characters:build']), /sorted and unique/),
    expectedFailure(database, 'credential-missing-evidence', credentialProbeSql(['characters:build'], { receipt: false }), /new external credential requires operation evidence/),
    expectedFailure(database, 'credential-enabled', credentialProbeSql(['characters:build'], { enabled: true }), /new external credential must be disabled and unused/),
    expectedFailure(database, 'credential-overbound', credentialProbeSql(capabilities.slice(0,51)), /external_credentials_capability_bound/),
  ] }
}
function declineProbeSql() {
  return `INSERT INTO semantic_reviewed_declines(id,tenant_id,venue_id,proposal_id,source_proposal_id,support_request_id,support_request_version,proposal_updated_at,reviewed_proposal_updated_at,reviewed_at,review_note_hash,input_hash,source_evidence,created_by)
    VALUES(md5('decline-probe')::uuid,'mr-t1','mr-v-a',md5('decline-a')::uuid,md5('decline-a')::uuid,'mr-support-a',1,'2026-09-01 12:00:00.123','2026-09-01 12:00:00.123','2026-09-01 12:00:00.123',encode(sha256(convert_to('Synthetic review','UTF8')),'hex'),repeat('a',64),'[{"sourceId":"support-message:mr-message-a"}]','fixture');`
}
function finalAssertions(database, prior) {
  const state = topology(database, 247)
  const after = snapshot(database, '247-before-negative-probes')
  const preservation = assertPreserved(prior, after)
  for (const row of after.venues) assert.equal(row.conversation_learning_policy, 'VISITOR_AND_EMPLOYEE')
  for (const row of after.conversation_insights) { assert.equal(row.candidate_revision, 0); assert.equal(row.candidate_provenance, null); assert.equal(row.reviewer_feedback, null) }
  for (const row of after.support_messages.filter(row => row.id.startsWith('mr-message-'))) assert.equal(row.completion_outcome, null)
  for (const row of after.intake_source_agent_routing_policies) { assert.equal(row.enabled, false); assert.equal(row.revision, 1) }
  assert.equal(after.semantic_reviewed_declines.length, 0)
  assert.equal(after.intake_source_agent_dispatches.length, prior.intake_source_agent_dispatches?.length ?? 0, 'No historical completed extraction may gain a fabricated dispatch')
  assert.equal(after.intake_v1_processing_dispatches.length, 3)
  const contentTables = ['knowledge_proposal_package_handoffs','knowledge_proposal_operational_update_handoffs','knowledge_proposal_universal_content_handoffs','legacy_knowledge_universal_content_adoptions','semantic_conflict_resolutions']
  const expected = new Set(contentTables.flatMap(table => after[table].map(row => `${row.proposal_id}|${row.tenant_id}|${row.venue_id}|CONTENT`)))
  for (const row of after.semantic_duplicate_resolutions) expected.add(`${row.proposal_id}|${row.tenant_id}|${row.venue_id}|DUPLICATE`)
  const actual = new Set(after.semantic_proposal_outcome_claims.map(row => `${row.proposal_id}|${row.tenant_id}|${row.venue_id}|${row.outcome_kind}`))
  assert.deepEqual(actual, expected)
  const negatives = [
    expectedFailure(database, 'claim-update', "UPDATE semantic_proposal_outcome_claims SET outcome_kind='DECLINED'", /claims are immutable/),
    expectedFailure(database, 'claim-delete', 'DELETE FROM semantic_proposal_outcome_claims', /claims are immutable/),
    expectedFailure(database, 'claim-truncate', 'TRUNCATE semantic_proposal_outcome_claims', /claims are immutable|foreign key constraint/),
    expectedFailure(database, 'wrong-claim-scope', "INSERT INTO semantic_proposal_outcome_claims(proposal_id,tenant_id,venue_id,outcome_kind) VALUES(md5('empty-a')::uuid,'mr-t2','mr-v-c','CONTENT')", /semantic_proposal_outcome_claims_proposal_fkey/),
    expectedFailure(database, 'negative-insight-revision', 'UPDATE conversation_insights SET candidate_revision=-1', /conversation_insights_candidate_revision_check/),
    expectedFailure(database, 'invalid-completion', "INSERT INTO support_messages(id,tenant_id,venue_id,support_request_id,author_kind,author_id,visibility,body,request_version,submission_request_id,submission_input_hash,completion_outcome) VALUES('mr-invalid','mr-t1','mr-v-a','mr-support-a','OPERATOR','fixture','INTERNAL_ONLY','Invalid completion',1,md5('invalid')::uuid,repeat('a',64),'NO_CHANGE')", /support_messages_completion_outcome_shape_check/),
  ]
  const capabilities = capabilityAssertions(database)
  const decline = jsonQuery(database, `BEGIN; ${declineProbeSql()} SELECT jsonb_build_object('count',(SELECT count(*) FROM semantic_reviewed_declines),'kind',(SELECT outcome_kind FROM semantic_proposal_outcome_claims WHERE proposal_id=md5('decline-a')::uuid)); ROLLBACK;`, 'valid-reviewed-decline')
  assert.deepEqual(decline, { count: 1, kind: 'DECLINED' })
  negatives.push(
    expectedFailure(database, 'decline-update', `${declineProbeSql()} UPDATE semantic_reviewed_declines SET input_hash=repeat('b',64)`, /Semantic reviewed declines are append-only/),
    expectedFailure(database, 'decline-delete', `${declineProbeSql()} DELETE FROM semantic_reviewed_declines`, /Semantic reviewed declines are append-only/),
    expectedFailure(database, 'decline-truncate', `${declineProbeSql()} TRUNCATE semantic_reviewed_declines`, /claims are immutable/),
    expectedFailure(database, 'decline-stale-source', declineProbeSql().replace("'mr-support-a',1", "'mr-support-a',2"), /exact direct or one-hop support source/),
    expectedFailure(database, 'routing-cross-tenant', "INSERT INTO intake_source_agent_routing_policies(id,tenant_id,venue_id,agent_identity_id,created_by,updated_by,updated_at) VALUES(md5('bad-routing')::uuid,'mr-t2','mr-v-a','mr-agent-a','fixture','fixture',CURRENT_TIMESTAMP)", /intake_source_agent_routing_venue_fkey|intake_source_agent_routing_identity_fkey/),
    expectedFailure(database, 'character-cross-tenant', "INSERT INTO character_candidate_review_briefs(id,tenant_id,venue_id,custom_character_id,candidate_version,candidate_revision,artifact_fingerprint,brief,rationale,source_provenance,created_by) VALUES('mr-bad-brief','mr-t1','mr-v-a','mr-character-c',1,1,repeat('c',64),'Synthetic','Scope test','IMPORTED_FIXTURE','fixture')", /character_candidate_review_briefs_character_fkey/),
    expectedFailure(database, 'dispatch-completion-shape', "INSERT INTO intake_source_agent_dispatches(id,tenant_id,venue_id,extraction_dispatch_id,intake_run_id,receipt_id,extracted_text_hash,status,updated_at) VALUES(md5('bad-dispatch')::uuid,'mr-t1','mr-v-a','mr-processing-a','mr-intake-a',md5('extraction-a')::uuid,repeat('a',64),'COMPLETED',CURRENT_TIMESTAMP)", /intake_source_agent_dispatch_completion_check/),
    expectedFailure(database, 'dispatch-cross-venue-receipt', after.intake_source_agent_dispatches.length ? "UPDATE intake_source_agent_dispatches SET receipt_id=md5('extraction-b')::uuid WHERE extraction_dispatch_id='mr-processing-a'" : "INSERT INTO intake_source_agent_dispatches(id,tenant_id,venue_id,extraction_dispatch_id,intake_run_id,receipt_id,extracted_text_hash,updated_at) VALUES(md5('bad-receipt')::uuid,'mr-t1','mr-v-a','mr-processing-a','mr-intake-a',md5('extraction-b')::uuid,repeat('a',64),CURRENT_TIMESTAMP)", /intake_source_agent_dispatch_receipt_fkey/),
  )
  if (after.semantic_duplicate_resolutions.length) {
    negatives.push(
      expectedFailure(database, 'duplicate-outcome-identity', "INSERT INTO semantic_duplicate_resolutions SELECT (jsonb_populate_record(NULL::semantic_duplicate_resolutions,to_jsonb(t)||jsonb_build_object('id',md5('duplicate-key-probe')::uuid))).* FROM semantic_duplicate_resolutions t WHERE proposal_id=md5('duplicate-a')::uuid", /semantic_duplicate_resolution_proposal_key/),
      expectedFailure(database, 'source-dispatch-identity', "INSERT INTO intake_source_agent_dispatches SELECT (jsonb_populate_record(NULL::intake_source_agent_dispatches,to_jsonb(t)||jsonb_build_object('id',md5('dispatch-key-probe')::uuid))).* FROM intake_source_agent_dispatches t WHERE extraction_dispatch_id='mr-processing-a'", /intake_source_agent_dispatch_extraction_key/),
      expectedFailure(database, 'character-result-job-identity', "INSERT INTO character_candidate_review_briefs SELECT (jsonb_populate_record(NULL::character_candidate_review_briefs,to_jsonb(t)||jsonb_build_object('id','mr-brief-probe','candidate_revision',2))).* FROM character_candidate_review_briefs t WHERE id='mr-brief-a'; INSERT INTO character_candidate_review_decisions SELECT (jsonb_populate_record(NULL::character_candidate_review_decisions,to_jsonb(t)||jsonb_build_object('id','mr-decision-probe','brief_id','mr-brief-probe','candidate_revision',2,'operation_id','mr-operation-probe'))).* FROM character_candidate_review_decisions t WHERE id='mr-decision-a'", /character_candidate_review_decisions_(resulting_job_id|job_scope)_key/),
    )
  }
  assertPreserved(after, snapshot(database, '247-after-negative-probes'))
  const beforeReplay = ledger(database)
  const replay = deploy(database, 247)
  assert(replay.noPending, 'Final deployment must report no pending migrations')
  assert.deepEqual(ledger(database), beforeReplay)
  assertPreserved(after, snapshot(database, '247-replay'))
  return { state, preservation, capabilities, decline, claimCount: actual.size, contentFamilies: contentTables.map(table => ({ table, count: after[table].length })), negatives, replay }
}
await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(Number(port), '127.0.0.1', () => server.close(resolve)) })
let started = false
try {
  run('initdb', path.join(bin, 'initdb.exe'), ['-D', data, '-U', 'postgres', '--auth-local=trust', '--auth-host=trust', '--encoding=UTF8', '--locale=C'])
  run('start', path.join(bin, 'pg_ctl.exe'), ['-D', data, '-l', path.join(proof, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c timezone=UTC`, '-w', 'start'])
  started = true
  for (const name of ['uninterrupted', 'critical', 'contradiction', 'corrected']) {
    console.log(`migration-rehearsal: starting ${name}; ${proof}`)
    const database = createDatabase(name)
    const baseline = predecessor(database, name !== 'uninterrupted')
    const record = result.cases[name] = { database, baseline, passed: false }
    if (name === 'contradiction') {
      seed(database, '245-contradiction')
      const before = snapshot(database, '245-contradictory')
      const schemaBefore = schemaSnapshot(database)
      record.deploy = deploy(database, 247, false)
      assert.match(readFileSync(record.deploy.log, 'utf8') + readFileSync(path.join(proof, 'postgres.log'), 'utf8'), /Existing proposal has contradictory duplicate and content outcomes/)
      record.failedLedger = ledger(database)
      assert.equal(record.failedLedger.length, 246)
      const failed = record.failedLedger.at(-1)
      assert.equal(failed.migration_name, migrations[245].name); assert.equal(failed.checksum, migrations[245].gitSha256)
      assert.equal(failed.finished_at, null); assert.equal(failed.rolled_back_at, null)
      // Prisma can fail its ledger-log update inside the aborted explicit transaction.
      // Preserve null logs honestly; the exact cause is retained in postgres.log.
      record.failedLedgerLogs = failed.logs
      record.preservation = assertPreserved(before, snapshot(database, '246-failed'))
      assert.deepEqual(schemaSnapshot(database), schemaBefore, 'Failed transaction changed schema')
      record.failedReplay = deploy(database, 247, false)
      assert.match(readFileSync(record.failedReplay.log, 'utf8'), /P3009|failed migrations/)
      assert.deepEqual(ledger(database), record.failedLedger)
      record.passed = true; result.failedFixturePreserved = true
    } else {
      if (name === 'critical') {
        const archive = path.join(proof, 'valid-245-backup.dump')
        record.backup = run('backup-245', path.join(bin, 'pg_dump.exe'), ['-Fc', '--no-owner', '-d', database, '-f', archive])
        record.backup.archive = archive; record.backup.sha256 = sha256(readFileSync(archive)); record.backup.ledger = ledger(database)
        record.backup.list = run('backup-list', path.join(bin, 'pg_restore.exe'), ['--list', archive])
      }
      record.deploy = name === 'critical' ? await lockObservedDeploy(database) : deploy(database, 247)
      record.assertions = finalAssertions(database, baseline.base)
      if (name === 'critical') record.concurrency = await concurrentOutcomeAssertions(database)
      record.passed = true
    }
    save()
    console.log(`migration-rehearsal: ${name} passed`)
  }
  const database = createDatabase('restore')
  const backup = result.cases.critical.backup
  assert.equal(sha256(readFileSync(backup.archive)), backup.sha256)
  const restored = result.cases.restore = { database, backupSha256: backup.sha256, passed: false }
  restored.restore = run('restore-245', path.join(bin, 'pg_restore.exe'), ['--exit-on-error', '--no-owner', '-d', database, backup.archive])
  assert.deepEqual(ledger(database), backup.ledger)
  restored.preservation = assertPreserved(result.cases.critical.baseline.base, snapshot(database, 'restored-245'))
  topology(database, 245)
  restored.deploy = deploy(database, 247)
  restored.assertions = finalAssertions(database, result.cases.critical.baseline.base)
  restored.passed = true
  result.sourceHashesStable = sourceManifest.every(row => sha256(readFileSync(path.join(repo, row.source))) === row.sha256)
  result.migrationFilesystemHashesStable = migrations.every(row => sha256(readFileSync(path.join(repo, row.source))) === row.filesystemSha256)
  result.executedSnapshotHashesStable = [...snapshots].every(([count, root]) => migrations.slice(0, count).every(row => sha256(readFileSync(path.join(root, row.source))) === row.gitSha256))
  assert(result.migrationFilesystemHashesStable && result.executedSnapshotHashesStable, 'Migration bytes changed during proof')
  assert.equal(git('diff', '--name-only', candidate, '--', ...migrationPaths).toString().trim(), '')
} catch (error) {
  result.error = { message: error.message, stack: error.stack }
  process.exitCode = 1
} finally {
  if (started) {
    const stopped = run('stop', path.join(bin, 'pg_ctl.exe'), ['-D', data, '-m', 'fast', '-w', 'stop'], { allowFailure: true })
    result.stopped = stopped.status === 0
    if (result.stopped) {
      result.stopStatus = run('stopped-status', path.join(bin, 'pg_ctl.exe'), ['-D', data, 'status'], { allowFailure: true })
      result.portReleased = await new Promise(resolve => { const server = createServer(); server.once('error', () => resolve(false)); server.listen(Number(port), '127.0.0.1', () => server.close(() => resolve(true))) })
      result.stopped = result.stopStatus.status === 3 && result.portReleased
    }
  }
  result.finishedAt = new Date().toISOString()
  result.observedHeadAtFinish = git('rev-parse', 'HEAD').toString().trim()
  try { assertSuccessfulResult(result); result.passed = true } catch (error) { result.admissionFailure = error.message; process.exitCode = 1 }
  save()
  if (result.passed) writeFileSync(path.join(repo, 'docs/evidence/migration-236-247-admission-2026-09-10.json'), JSON.stringify({ ...result, resultSha256: sha256(readFileSync(path.join(proof, 'result.json'))) }, null, 2))
  console.log(JSON.stringify({ proof, passed: result.passed, stopped: result.stopped, error: result.error?.message, admissionFailure: result.admissionFailure }))
}
