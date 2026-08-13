const STAGING_SEED_OPT_IN = 'PATHFINDER_ALLOW_STAGING_SEED'
const DATABASE_HOST_CONFIRMATION = 'PATHFINDER_CONFIRM_STAGING_DATABASE_HOST'
const DIRECT_DATABASE_HOST_CONFIRMATION = 'PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST'
const DATABASE_NAME_CONFIRMATION = 'PATHFINDER_CONFIRM_STAGING_DATABASE_NAME'

export interface StagingSeedEnvironment {
  RAILWAY_ENVIRONMENT?: string | undefined
  DATABASE_URL?: string | undefined
  DIRECT_DATABASE_URL?: string | undefined
  PATHFINDER_ALLOW_STAGING_SEED?: string | undefined
  PATHFINDER_CONFIRM_STAGING_DATABASE_HOST?: string | undefined
  PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST?: string | undefined
  PATHFINDER_CONFIRM_STAGING_DATABASE_NAME?: string | undefined
}

function parsePostgresTarget(value: string | undefined, label: string) {
  if (!value) throw new Error(`${label} is required for staging seed confirmation`)

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`)
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${label} must use PostgreSQL`)
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''))
  if (!url.hostname || !database || database.includes('/')) {
    throw new Error(`${label} must identify one host and database`)
  }

  return { host: url.hostname.toLowerCase(), database }
}

export function assertStagingSeedTarget(environment: StagingSeedEnvironment) {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Staging seed requires RAILWAY_ENVIRONMENT=staging')
  }
  if (environment[STAGING_SEED_OPT_IN] !== '1') {
    throw new Error(`Staging seed requires ${STAGING_SEED_OPT_IN}=1`)
  }

  const pooled = parsePostgresTarget(environment.DATABASE_URL, 'DATABASE_URL')
  const direct = parsePostgresTarget(environment.DIRECT_DATABASE_URL, 'DIRECT_DATABASE_URL')
  if (pooled.database !== direct.database) {
    throw new Error('Staging database URLs do not identify the same database')
  }
  if (environment[DATABASE_HOST_CONFIRMATION]?.toLowerCase() !== pooled.host) {
    throw new Error(`${DATABASE_HOST_CONFIRMATION} does not match DATABASE_URL`)
  }
  if (environment[DIRECT_DATABASE_HOST_CONFIRMATION]?.toLowerCase() !== direct.host) {
    throw new Error(`${DIRECT_DATABASE_HOST_CONFIRMATION} does not match DIRECT_DATABASE_URL`)
  }
  if (environment[DATABASE_NAME_CONFIRMATION] !== pooled.database) {
    throw new Error(`${DATABASE_NAME_CONFIRMATION} does not match the target database`)
  }

  return {
    databaseHost: pooled.host,
    directDatabaseHost: direct.host,
    database: pooled.database,
  }
}
