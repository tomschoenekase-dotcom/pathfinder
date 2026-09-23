/** One foreground, provider-dark native HTTP acceptance. One task-owned PG
 * container runs native migrations with a separate migrator; runtime is DML-only.
 * No shared cluster role, original database, provider or CRM content is changed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { buildShakedownChildEnv } from './lib/disposable-intake-upload-verification.mjs'
import { runDisposableMigration, redactDatabaseOutput } from './lib/disposable-prisma-migration.mjs'

const root = path.resolve(import.meta.dirname, '..')
const qaRoot = path.resolve(root, '../qa')
const syntheticComponents = process.argv.length === 3 && process.argv[2] === '--synthetic-components'
assert(process.argv.length === 2 || syntheticComponents, 'Only the explicit synthetic CI mode is supported')
const rootRequire = createRequire(path.join(root, 'packages/db/package.json'))
let clientMode
if (syntheticComponents) {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Synthetic contract mode is confined to the existing isolated GitHub runner')
  const clientRequire = createRequire(rootRequire.resolve('@prisma/client/package.json'))
  const generated = readFileSync(clientRequire.resolve('.prisma/client/schema.prisma'), 'utf8')
  assert.equal(generated.replaceAll('\r\n', '\n'), readFileSync(path.join(root, 'packages/db/prisma/schema.prisma'), 'utf8').replaceAll('\r\n', '\n'),
    'CI must generate the complete exact-source Prisma client, not borrow a compatible local client')
  clientMode = 'FULL_EXACT_SOURCE_SCHEMA'
} else {
  const admission = JSON.parse(readFileSync(path.join(qaRoot, 'NATIVE-CLIENT-ADMISSION.json'), 'utf8'))
  assert.equal(realpathSync(path.dirname(rootRequire.resolve('@prisma/client/package.json'))), realpathSync(admission.frozenClient))
  assert.equal(admission.matchedSchemaBlocks.length, 503)
  assert(root.includes('20260923-four-chat-lane-03-outreach'))
  clientMode = 'COMPATIBLE_503_BLOCK_LOCAL_ADMISSION'
}
const suffix = randomBytes(6).toString('hex'), database = 'pathfinder_disposable_agent_bridge_' + suffix
const container = 'torchiko-l3-http-' + suffix
const image = 'pgvector/pgvector@sha256:a36250871de0833b8757561c72f2477ef1ddd1101afa4e617fb552e0de514c6b'
const role = 'syn_outreach_' + suffix, password = randomBytes(32).toString('hex')
const migrator = 'syn_migrator_' + suffix, migrationPassword = randomBytes(32).toString('hex')
const output = path.join(qaRoot, 'http-' + suffix)
mkdirSync(output, { recursive: true })
let vault = 'C:/Users/tomsc/Downloads/AwesomeVault'
if (syntheticComponents) {
  // No private source is copied. This is an explicitly synthetic input to the
  // existing component boundary, NOT installed WLT/Composer/reference proof.
  vault = path.join(output, 'synthetic-contract-vault')
  const guideDir = path.join(vault, '95 AI Staging', 'Torchiko Sales Writing Reference 2026-09-21', 'v0.2-r001')
  mkdirSync(guideDir, { recursive: true })
  writeFileSync(path.join(vault, 'SYNTHETIC-HTTP-CONTRACT-ONLY'), 'No private corpus. No installed WLT. No live CRM.\n', { flag: 'wx' })
  writeFileSync(path.join(guideDir, 'TORCHIKO-WRITING-REFERENCE.md'),
    '# SYNTHETIC contract reference\nNot Tom authorship, installed WLT, a real venue, or permission to send.\n', { flag: 'wx' })
}
let databaseUrl = `postgresql://${role}:${password}@127.0.0.1:1/${database}`
const env = buildShakedownChildEnv(process.env, { databaseUrl, redisPort: 1,
  bucket: 'unused-synthetic', minioPort: 1, minioUser: 'unused', minioPassword: 'unused',
  clamavPort: 1, clerkSecret: 'synthetic-unused', clerkPublishable: 'synthetic-unused' })
for (const key of Object.keys(env)) if (key.startsWith('TORCHIKO_') || key.startsWith('AGENT_BRIDGE_') || key.startsWith('RUN_')) delete env[key]
Object.assign(env, { INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED: 'false',
  AGENT_RUNNER_ENABLED: 'false', AGENT_ROUTINES_ENABLED: 'false',
  AGENT_BRIDGE_HTTP_ENABLED: 'true', TORCHIKO_AUTHENTICATED_CRM_SALES_ENABLED: '1',
  TORCHIKO_AUTH_HTTP_ACCEPTANCE: '1', TORCHIKO_AUTH_HTTP_QA_DIR: output,
  TORCHIKO_AUTH_HTTP_CLIENT_MODE: clientMode,
  TORCHIKO_AUTH_HTTP_COMPONENT_MODE: syntheticComponents ? 'SYNTHETIC_CONTRACT_NOT_INSTALLED_WLT' : 'PRIVATE_INSTALLED_OWNERS',
  TORCHIKO_CRM_SALES_BRIDGE: path.join(root, syntheticComponents
    ? 'scripts/fixtures/authenticated-outreach/component_bridge.py' : 'scripts/crm-sales/component_bridge.py'),
  TORCHIKO_CRM_VAULT: vault,
  PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS: '1', PATHFINDER_DISPOSABLE_DATABASE_URL: databaseUrl,
  PRISMA_HIDE_UPDATE_MESSAGE: '1', NODE_OPTIONS: '--max-old-space-size=384' })
const safe = text => redactDatabaseOutput(String(text), [password, migrationPassword, databaseUrl])
const receipt = { schema: 'torchiko.authenticated-outreach-resource/1', database, role, container,
  clientMode, componentMode: env.TORCHIKO_AUTH_HTTP_COMPONENT_MODE,
  schemaSha256: createHash('sha256').update(readFileSync(path.join(root, 'packages/db/prisma/schema.prisma'))).digest('hex'),
  host: '127.0.0.1', port: null, image, ownershipLabel: 'torchiko-lane03-auth-http',
  originalCRMModified: false, existingDatabaseModified: false, sharedClusterRolesModified: false,
  startedAt: new Date().toISOString(), created: false, migrationPassed: false, acceptancePassed: false,
  discarded: false, output }
const persist = () => writeFileSync(path.join(output, 'RESOURCE-RECEIPT.json'), JSON.stringify(receipt, null, 2) + '\n')
persist()
function docker(args, input, extraEnv = {}, acceptFailure = false) {
  const result = spawnSync('docker', args, { input, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/iu.test(key))), ...extraEnv } })
  if (acceptFailure) return result.status === 0
  if (result.status !== 0) throw new Error('Synthetic Docker operation held: ' + safe(result.stderr).slice(-1500))
  return result.stdout
}
function sql(value, db = database) {
  // Secret is written only through stdin; no password enters argv or a shell script.
  return docker(['exec', '-i', container, 'sh', '-c',
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$1"', '--', db], value)
}
try {
  docker(['run', '--detach', '--rm', '--pull=never', '--name', container,
    '--label', 'torchiko.acceptance=lane03-auth-http', '--label', 'torchiko.owner=20260923-four-chat-lane-03-outreach',
    '--memory=128m', '--cpus=1', '--publish', '127.0.0.1::5432',
    '--env', 'POSTGRES_USER', '--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_DB', image,
    '-c', 'shared_buffers=16MB', '-c', 'work_mem=1MB', '-c', 'maintenance_work_mem=16MB', '-c', 'max_connections=20'], undefined,
    { POSTGRES_USER: migrator, POSTGRES_PASSWORD: migrationPassword, POSTGRES_DB: database })
  receipt.created = true
  persist()
  const portMatch = /^127\.0\.0\.1:(\d+)$/u.exec(docker(['port', container, '5432/tcp']).trim())
  assert(portMatch); const port = Number(portMatch[1]); receipt.port = port; persist()
  let ready = false
  for (let attempt = 0; attempt < 30; attempt++) {
    if (docker(['exec', container, 'pg_isready', '-U', migrator, '-d', database], undefined, {}, true)) { ready = true; break }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
  }
  assert(ready, 'Task-owned PostgreSQL did not become ready')
  databaseUrl = `postgresql://${role}:${password}@127.0.0.1:${port}/${database}`
  const migrationUrl = `postgresql://${migrator}:${migrationPassword}@127.0.0.1:${port}/${database}`
  Object.assign(env, { DATABASE_URL: databaseUrl, DIRECT_DATABASE_URL: databaseUrl,
    TORCHIKO_AUTH_HTTP_PG_PORT: String(port), PATHFINDER_DISPOSABLE_DATABASE_URL: migrationUrl })
  let migrationLog = ''
  const sink = { write: value => { migrationLog += value } }
  const migration = runDisposableMigration({ argv: ['--database', database, '--confirm-database', database],
    env, repoRoot: root, stdout: sink, stderr: sink })
  writeFileSync(path.join(output, 'migration.log'), safe(migrationLog), { flag: 'wx' })
  if (migration !== 0) {
    try { writeFileSync(path.join(output, 'migration-failure-detail.log'), safe(sql('SELECT migration_name, logs FROM _prisma_migrations WHERE finished_at IS NULL;')), { flag: 'wx' }) } catch {}
  }
  assert.equal(migration, 0, 'Native migrations failed; no db-push/reset/fallback')
  receipt.migrationPassed = true
  persist()
  sql(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';\n` +
    `GRANT CONNECT ON DATABASE ${database} TO ${role};\nGRANT USAGE ON SCHEMA public TO ${role};\n` +
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role};\n` +
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${role};\n`)
  const req = createRequire(path.join(root, 'package.json'))
  const result = spawnSync(process.execPath, [req.resolve('tsx/cli'), path.join(root, 'scripts/accept-authenticated-outreach-http.ts')],
    { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 2000000 })
  writeFileSync(path.join(output, 'acceptance.log'), safe(`${result.stdout ?? ''}\n${result.stderr ?? ''}`), { flag: 'wx' })
  receipt.acceptancePassed = result.status === 0
  assert.equal(result.status, 0, 'Actual HTTP acceptance did not pass; retain the exact failure receipt')
} catch (error) { receipt.failure = safe(error.message); process.exitCode = 1 }
finally {
  if (receipt.created) {
    try {
      const label = docker(['inspect', '--format', '{{index .Config.Labels "torchiko.owner"}}', container]).trim()
      assert.equal(label, '20260923-four-chat-lane-03-outreach')
      docker(['rm', '--force', container])
      receipt.discarded = true
    } catch (error) { receipt.cleanupHold = safe(error.message); process.exitCode = 1 }
  }
  receipt.finishedAt = new Date().toISOString()
  persist()
  console.log(JSON.stringify(receipt, null, 2))
}
