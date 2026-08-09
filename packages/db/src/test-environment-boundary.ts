const SYNTHETIC_UNIT_DATABASE_URL =
  'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DISPOSABLE_DATABASE_PATTERN = /^pathfinder_disposable_[a-z0-9_]+$/

export class DatabaseTestEnvironmentRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseTestEnvironmentRefusal'
  }
}

function isIntegrationEnabled(environment: NodeJS.ProcessEnv): boolean {
  return Object.entries(environment).some(
    ([name, value]) => /^RUN_[A-Z0-9_]*DB_INTEGRATION$/u.test(name) && value === '1',
  )
}

function validatedTarget(raw: string | undefined): string {
  if (!raw)
    throw new DatabaseTestEnvironmentRefusal('Explicit integration database URLs are required')

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DatabaseTestEnvironmentRefusal('Integration database URL is malformed')
  }
  const host = url.hostname.replace(/^\[|\]$/gu, '').toLocaleLowerCase('en-US')
  const database = decodeURIComponent(url.pathname.slice(1))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !LOOPBACK_HOSTS.has(host) ||
    !url.port ||
    url.search ||
    url.hash ||
    !DISPOSABLE_DATABASE_PATTERN.test(database)
  ) {
    throw new DatabaseTestEnvironmentRefusal(
      'Integration tests require an exact loopback pathfinder_disposable_* database',
    )
  }
  const normalized = new URL(url.toString())
  if (host === 'localhost') normalized.hostname = '127.0.0.1'
  return normalized.toString()
}

export function resolveDatabaseTestEnvironment(environment: NodeJS.ProcessEnv): {
  databaseUrl: string
  directDatabaseUrl: string
  integration: boolean
} {
  if (!isIntegrationEnabled(environment)) {
    return {
      databaseUrl: SYNTHETIC_UNIT_DATABASE_URL,
      directDatabaseUrl: SYNTHETIC_UNIT_DATABASE_URL,
      integration: false,
    }
  }

  const databaseUrl = validatedTarget(environment.DATABASE_URL)
  const directDatabaseUrl = validatedTarget(environment.DIRECT_DATABASE_URL)
  if (databaseUrl !== directDatabaseUrl) {
    throw new DatabaseTestEnvironmentRefusal(
      'DATABASE_URL and DIRECT_DATABASE_URL must identify the same disposable target',
    )
  }
  return { databaseUrl, directDatabaseUrl, integration: true }
}
