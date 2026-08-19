import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const DISPOSABLE_DATABASE_PATTERN = /^pathfinder_disposable_[a-z0-9_]+$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DATABASE_ENV_KEYS = new Set(['database_url', 'direct_database_url'])

export class DisposableMigrationRefusal extends Error {}

function refuse(message) {
  throw new DisposableMigrationRefusal(message)
}

export function parseDisposableMigrationArgs(argv) {
  let database
  let confirmation
  const args = argv[0] === '--' ? argv.slice(1) : argv

  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (value === undefined) refuse('every option requires a value')

    if (flag === '--database' && database === undefined) database = value
    else if (flag === '--confirm-database' && confirmation === undefined) confirmation = value
    else refuse('only --database and --confirm-database are accepted once each')
  }

  if (database === undefined || confirmation === undefined) {
    refuse('--database and --confirm-database are both required')
  }
  if (database !== confirmation) refuse('database confirmation does not match')
  if (database.length > 63 || !DISPOSABLE_DATABASE_PATTERN.test(database)) {
    refuse(
      'database name must use the pathfinder_disposable_ prefix and lowercase identifier characters',
    )
  }

  return { database }
}

function normalizedHostname(url) {
  const hostname = url.hostname.toLowerCase()
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function safelyDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function validateDisposableDatabaseUrl(raw, expectedDatabase) {
  if (typeof raw !== 'string' || raw.length === 0) refuse('disposable database URL is required')

  let url
  try {
    url = new URL(raw)
  } catch {
    refuse('disposable database URL is malformed')
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    refuse('disposable database URL must use PostgreSQL')
  }
  if (url.port === '') refuse('disposable database URL must include an explicit port')
  if (url.search !== '' || url.hash !== '') {
    refuse('disposable database URL cannot contain query parameters or a fragment')
  }

  const hostname = normalizedHostname(url)
  if (!LOOPBACK_HOSTS.has(hostname)) refuse('disposable database URL must use exact loopback')
  if (url.pathname !== `/${expectedDatabase}`) {
    refuse('disposable database URL database name does not match the confirmation')
  }

  const canonical = new URL(url.toString())
  if (hostname === 'localhost') canonical.hostname = '127.0.0.1'

  return {
    canonicalUrl: canonical.toString(),
    database: expectedDatabase,
    host: hostname === 'localhost' ? '127.0.0.1' : hostname,
    port: url.port,
    sensitiveTokens: [
      raw,
      canonical.toString(),
      url.username,
      safelyDecode(url.username),
      url.password,
      safelyDecode(url.password),
    ].filter((token) => token.length > 0),
  }
}

export function buildDisposableChildEnv(parentEnv, canonicalUrl) {
  const childEnv = {}

  for (const [key, value] of Object.entries(parentEnv)) {
    const lowerKey = key.toLowerCase()
    if (DATABASE_ENV_KEYS.has(lowerKey)) continue
    if (lowerKey === 'node_options' || lowerKey === 'node_path') continue
    if (lowerKey === 'no_color' || lowerKey === 'force_color') continue
    if (lowerKey === 'pathfinder_disposable_database_url') continue
    if (lowerKey === 'pathfinder_allow_disposable_migrations') continue
    if (lowerKey === 'prisma_config_path') continue
    if (/^prisma_.*(?:engine|binary|library)/i.test(key)) continue
    if (/^pg(?:host|port|database|user|password|service|passfile|options|ssl)/i.test(key)) continue
    childEnv[key] = value
  }

  childEnv.DATABASE_URL = canonicalUrl
  childEnv.DIRECT_DATABASE_URL = canonicalUrl
  childEnv.NO_COLOR = '1'
  childEnv.FORCE_COLOR = '0'
  return childEnv
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function redactDatabaseOutput(value, sensitiveTokens = []) {
  let redacted = String(value).replace(/postgres(?:ql)?:\/\/[^\s"'`]+/gi, '[REDACTED_DATABASE_URL]')

  for (const token of sensitiveTokens.sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(new RegExp(escapeRegExp(token), 'g'), '[REDACTED]')
  }

  return redacted
}

export function runDisposableMigration({
  argv,
  env,
  spawnSyncImpl = spawnSync,
  stdout = process.stdout,
  stderr = process.stderr,
  repoRoot = resolve(import.meta.dirname, '..', '..'),
}) {
  if (env.PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS !== '1') {
    refuse('PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS must equal 1')
  }

  const { database } = parseDisposableMigrationArgs(argv)
  const target = validateDisposableDatabaseUrl(env.PATHFINDER_DISPOSABLE_DATABASE_URL, database)
  const dbPackage = resolve(repoRoot, 'packages', 'db')
  const prismaCli = resolve(dbPackage, 'node_modules', 'prisma', 'build', 'index.js')
  const schema = resolve(dbPackage, 'prisma', 'schema.prisma')
  const childEnv = buildDisposableChildEnv(env, target.canonicalUrl)

  stdout.write(
    `Disposable migration target confirmed: database=${target.database} host=loopback port=${target.port}.\n`,
  )

  const result = spawnSyncImpl(
    process.execPath,
    [prismaCli, 'migrate', 'deploy', '--schema', schema],
    {
      cwd: dbPackage,
      env: childEnv,
      shell: false,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  )

  if (result.stdout) stdout.write(redactDatabaseOutput(result.stdout, target.sensitiveTokens))
  if (result.stderr) stderr.write(redactDatabaseOutput(result.stderr, target.sensitiveTokens))
  if (result.error || typeof result.status !== 'number') {
    stderr.write('Disposable migration process could not be started safely.\n')
    return 1
  }

  return result.status
}
