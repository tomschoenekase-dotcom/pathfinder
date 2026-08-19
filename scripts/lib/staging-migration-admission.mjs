const PRODUCTION_PROJECT_REFS = Object.freeze(['zpacmfkomonxeqdiadtz'])
const MAX_APPROVED_STAGING_SPEND_USD = 10

function required(environment, key) {
  const value = environment[key]?.trim()
  if (!value) throw new Error(`${key} is required for staging migration admission`)
  return value
}

function parsePostgresTarget(environment, key) {
  const raw = required(environment, key)
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`${key} must be a valid PostgreSQL URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(`${key} must use PostgreSQL`)
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ''))
  if (!url.hostname || !database || database.includes('/')) {
    throw new Error(`${key} must identify one host and database`)
  }
  return { host: url.hostname.toLowerCase(), database, raw: raw.toLowerCase() }
}

function assertNotProduction(value, label) {
  const normalized = value.toLowerCase()
  if (PRODUCTION_PROJECT_REFS.some((projectRef) => normalized.includes(projectRef))) {
    throw new Error(`${label} identifies the production project and is forbidden`)
  }
}

export function assertStagingMigrationAdmission(environment) {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Staging migration requires RAILWAY_ENVIRONMENT=staging')
  }
  if (environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS !== '1') {
    throw new Error('Staging migration requires PATHFINDER_ALLOW_STAGING_MIGRATIONS=1')
  }
  if (environment.PATHFINDER_CONFIRM_STAGING_DATA_POLICY !== 'synthetic-only') {
    throw new Error(
      'Staging migration requires PATHFINDER_CONFIRM_STAGING_DATA_POLICY=synthetic-only',
    )
  }

  const spendCeiling = Number(required(environment, 'PATHFINDER_STAGING_SPEND_CEILING_USD'))
  if (
    !Number.isFinite(spendCeiling) ||
    spendCeiling <= 0 ||
    spendCeiling > MAX_APPROVED_STAGING_SPEND_USD
  ) {
    throw new Error('Staging spend ceiling must be greater than 0 and no more than 10 USD')
  }

  const releaseSha = required(environment, 'PATHFINDER_RELEASE_SHA').toLowerCase()
  const providerReleaseSha = required(environment, 'RAILWAY_GIT_COMMIT_SHA').toLowerCase()
  if (!/^[a-f0-9]{40}$/u.test(releaseSha) || releaseSha !== providerReleaseSha) {
    throw new Error('PATHFINDER_RELEASE_SHA must equal the full Railway release commit SHA')
  }

  const resource = required(environment, 'PATHFINDER_STAGING_DATABASE_RESOURCE')
  const confirmedResource = required(environment, 'PATHFINDER_CONFIRM_STAGING_DATABASE_RESOURCE')
  if (resource !== confirmedResource) {
    throw new Error('Confirmed staging database resource does not match the runtime resource')
  }
  assertNotProduction(resource, 'Staging database resource')

  const pooled = parsePostgresTarget(environment, 'DATABASE_URL')
  const direct = parsePostgresTarget(environment, 'DIRECT_DATABASE_URL')
  assertNotProduction(pooled.raw, 'DATABASE_URL')
  assertNotProduction(direct.raw, 'DIRECT_DATABASE_URL')
  if (pooled.database !== direct.database) {
    throw new Error('Staging database URLs do not identify the same database')
  }

  if (
    required(environment, 'PATHFINDER_CONFIRM_STAGING_DATABASE_HOST').toLowerCase() !== pooled.host
  ) {
    throw new Error('Confirmed staging database host does not match DATABASE_URL')
  }
  if (
    required(environment, 'PATHFINDER_CONFIRM_STAGING_DIRECT_DATABASE_HOST').toLowerCase() !==
    direct.host
  ) {
    throw new Error('Confirmed staging direct database host does not match DIRECT_DATABASE_URL')
  }
  if (required(environment, 'PATHFINDER_CONFIRM_STAGING_DATABASE_NAME') !== pooled.database) {
    throw new Error('Confirmed staging database name does not match the target database')
  }

  return Object.freeze({
    releaseSha,
    resource,
    databaseHost: pooled.host,
    directDatabaseHost: direct.host,
    database: pooled.database,
    spendCeilingUsd: spendCeiling,
  })
}

export const stagingMigrationPolicy = Object.freeze({
  maximumSpendUsd: MAX_APPROVED_STAGING_SPEND_USD,
  productionProjectRefs: PRODUCTION_PROJECT_REFS,
})
