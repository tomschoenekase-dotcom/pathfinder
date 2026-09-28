import { spawn } from 'node:child_process'
import { PassThrough } from 'node:stream'

const MAX_OUTPUT = 64 * 1024 * 1024
const DATABASE_PORTS = {
  pathfinder_disposable_source: new Set(['5432', '55432', '56232']),
  pathfinder_disposable_restore: new Set(['5433', '55433', '56233']),
}

function target(raw) {
  let url
  try { url = new URL(raw) } catch { throw new Error('invalid-disposable-database-url') }
  const database = decodeURIComponent(url.pathname.slice(1))
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1' || !DATABASE_PORTS[database]?.has(url.port) || !url.username || !url.password) {
    throw new Error('unsafe-disposable-database-target')
  }
  return { host: process.platform === 'win32' ? 'host.docker.internal' : '127.0.0.1', port: url.port, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database }
}

function runDocker(args, { input, maxOutput = MAX_OUTPUT, password } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: password } })
    const chunks = []
    let size = 0
    child.stdout.on('data', (chunk) => {
      size += chunk.length
      if (size > maxOutput) child.kill()
      else chunks.push(chunk)
    })
    // Provider stderr may contain URLs or private content. Never forward it.
    child.stderr.resume()
    child.on('error', () => reject(new Error('postgres-client-start-failed')))
    child.on('close', (code) => code === 0 && size <= maxOutput ? resolve(Buffer.concat(chunks)) : reject(new Error('postgres-client-failed')))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}

export async function postgresClient(rawUrl, command, { input, maxOutput } = {}) {
  const db = target(rawUrl)
  return runDocker(['run', '--rm', '-i', '--network', process.platform === 'win32' ? 'bridge' : 'host', '-e', 'PGPASSWORD', 'postgres:17', command.name, '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, ...command.args], { input, maxOutput, password: db.password })
}

export function postgresClientStream(rawUrl, command, { spawnImpl = spawn } = {}) {
  const db = target(rawUrl)
  const child = spawnImpl('docker', ['run', '--rm', '-i', '--network', process.platform === 'win32' ? 'bridge' : 'host', '-e', 'PGPASSWORD', 'postgres:17', command.name, '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, ...command.args], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PGPASSWORD: db.password } })
  const stream = new PassThrough()
  child.stdout.pipe(stream)
  // Provider stderr can include URLs or private dump text. It is deliberately discarded.
  child.stderr.resume()
  const completion = new Promise((resolve, reject) => {
    child.on('error', () => { stream.destroy(new Error('postgres-client-start-failed')); reject(new Error('postgres-client-start-failed')) })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else { const error = new Error('postgres-client-failed'); stream.destroy(error); reject(error) }
    })
  })
  // The caller is expected to consume the stream and await completion. Attach a handler
  // immediately so a spawn failure cannot become an unhandled rejection during setup.
  completion.catch(() => {})
  return { stream, completion, cancel: () => child.kill() }
}

export const syntheticSnapshotSql = "SELECT json_build_object('database',current_database(),'oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'ledger',(SELECT coalesce(json_agg(migration_name ORDER BY migration_name),'[]'::json) FROM _prisma_migrations WHERE finished_at IS NOT NULL),'tableCount',(SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),'fixtureCount',(SELECT count(*) FROM release_fixture),'fixtureFingerprint',(SELECT md5(coalesce(string_agg(id::text || ':' || value, ',' ORDER BY id),'')) FROM release_fixture))::text"

export const restoreTargetPreflightSql = "SELECT json_build_object('database',current_database(),'oid',(SELECT oid FROM pg_database WHERE datname=current_database()),'userObjectCount',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND c.relkind IN ('r','p','v','m','S','f')),'userFunctionCount',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'),'userTypeCount',(SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typrelid=0),'userOperatorCount',(SELECT count(*) FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname='public'),'extraSchemaCount',(SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','pg_toast','public')))::text"

export function validateEmptyRestoreTarget(state) {
  const validOid = (typeof state?.oid === 'number' && Number.isInteger(state.oid) && state.oid > 0 && state.oid <= 4_294_967_295)
    || (typeof state?.oid === 'string' && /^[1-9][0-9]*$/u.test(state.oid) && Number(state.oid) <= 4_294_967_295)
  if (!state || state.database !== 'pathfinder_disposable_restore' || !validOid || ['userObjectCount', 'userFunctionCount', 'userTypeCount', 'userOperatorCount', 'extraSchemaCount'].some((key) => state[key] !== 0)) throw new Error('restore-target-not-empty')
  return state
}

export async function assertEmptyRestoreTarget(rawUrl) {
  const out = await postgresClient(rawUrl, { name: 'psql', args: ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', restoreTargetPreflightSql] }, { maxOutput: 16_384 })
  let state
  try { state = JSON.parse(out.toString('utf8').trim()) } catch { throw new Error('invalid-restore-target-state') }
  return validateEmptyRestoreTarget(state)
}

export async function syntheticSnapshot(rawUrl) {
  const out = await postgresClient(rawUrl, { name: 'psql', args: ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', syntheticSnapshotSql] }, { maxOutput: 16_384 })
  try { return JSON.parse(out.toString('utf8').trim()) } catch { throw new Error('invalid-disposable-snapshot') }
}
