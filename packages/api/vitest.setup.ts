const syntheticTestEnvironment = {
  DATABASE_URL: 'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
  DIRECT_DATABASE_URL:
    'postgresql://pathfinder_test:pathfinder_test@127.0.0.1:5432/pathfinder_test',
  CLERK_SECRET_KEY: 'sk_test_pathfinder_unit_tests',
  CLERK_PUBLISHABLE_KEY: 'pk_test_pathfinder_unit_tests',
} as const

const disposableDatabaseIntegrationFlags = [
  'RUN_CONTENT_HISTORY_DB_INTEGRATION',
  'RUN_GENERATION_REQUEST_DB_INTEGRATION',
  'RUN_VENUE_AVAILABILITY_INTEGRATION',
  'RUN_VENUE_IMPORT_DB_INTEGRATION',
  'RUN_VENUE_PACKAGE_DB_INTEGRATION',
  'RUN_VENUE_REPORT_AUDIT_FAILURE_INTEGRATION',
  'RUN_VENUE_REPORT_CONFIGURATION_INTEGRATION',
] as const

function isExactDisposableDatabaseUrl(raw: string | undefined): boolean {
  if (!raw) return false

  try {
    const url = new URL(raw)
    const database = decodeURIComponent(url.pathname.slice(1))
    return (
      (url.protocol === 'postgresql:' || url.protocol === 'postgres:') &&
      ['127.0.0.1', 'localhost', '::1'].includes(url.hostname) &&
      url.port !== '' &&
      url.search === '' &&
      url.hash === '' &&
      /^pathfinder_disposable_[a-z0-9_]+$/.test(database)
    )
  } catch {
    return false
  }
}

const usesDisposableDatabase = disposableDatabaseIntegrationFlags.some(
  (name) => process.env[name] === '1',
)

if (usesDisposableDatabase) {
  const databaseUrl = process.env.DATABASE_URL
  const directDatabaseUrl = process.env.DIRECT_DATABASE_URL
  if (
    !isExactDisposableDatabaseUrl(databaseUrl) ||
    !isExactDisposableDatabaseUrl(directDatabaseUrl) ||
    databaseUrl !== directDatabaseUrl
  ) {
    throw new Error(
      'Database integration requires one matching exact-loopback pathfinder_disposable_* target',
    )
  }
} else {
  for (const [name, value] of Object.entries(syntheticTestEnvironment)) {
    process.env[name] = value
  }
}
