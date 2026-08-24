const PRODUCTION_PROJECT_REFS = Object.freeze(['zpacmfkomonxeqdiadtz'])
const MAX_APPROVED_STAGING_SPEND_USD = 10
const LOCAL_UPLOAD_APPROVAL = 'torchiko-stripe-billing-local-upload-20260820'
const MAX_PRESERVATION_EVIDENCE_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

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

function exactSha256(environment, key) {
  const value = required(environment, key).toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${key} must be an exact SHA-256`)
  return value
}

function canonicalTimestamp(environment, key) {
  const value = required(environment, key)
  const timestamp = new Date(value)
  if (!Number.isFinite(timestamp.valueOf()) || timestamp.toISOString() !== value) {
    throw new Error(`${key} must be a canonical ISO timestamp`)
  }
  return timestamp
}

function preservedDataEvidence(environment, { releaseSha, resource }, now) {
  const backupReleaseSha = required(
    environment,
    'PATHFINDER_STAGING_BACKUP_RELEASE_SHA',
  ).toLowerCase()
  if (backupReleaseSha !== releaseSha) {
    throw new Error('Staging backup evidence does not match the exact release SHA')
  }
  if (required(environment, 'PATHFINDER_STAGING_BACKUP_DATABASE_RESOURCE') !== resource) {
    throw new Error('Staging backup evidence does not match the target database resource')
  }
  const storageResource = required(environment, 'PATHFINDER_STAGING_BACKUP_STORAGE_RESOURCE')
  if (
    required(environment, 'PATHFINDER_CONFIRM_STAGING_BACKUP_STORAGE_RESOURCE') !== storageResource
  ) {
    throw new Error('Confirmed staging backup storage resource does not match backup evidence')
  }
  if (storageResource === resource) {
    throw new Error('Staging backup storage must be separate from the database resource')
  }
  assertNotProduction(storageResource, 'Staging backup storage resource')

  const ledgerCount = Number(required(environment, 'PATHFINDER_STAGING_BACKUP_LEDGER_COUNT'))
  if (!Number.isInteger(ledgerCount) || ledgerCount < 1) {
    throw new Error('Staging backup ledger count must be a positive integer')
  }
  const createdAt = canonicalTimestamp(environment, 'PATHFINDER_STAGING_BACKUP_CREATED_AT')
  const restoreVerifiedAt = canonicalTimestamp(
    environment,
    'PATHFINDER_STAGING_BACKUP_RESTORE_VERIFIED_AT',
  )
  const nowMs = now.valueOf()
  if (!Number.isFinite(nowMs)) throw new Error('Invalid staging migration admission clock')
  if (
    createdAt > restoreVerifiedAt ||
    createdAt.valueOf() > nowMs + MAX_CLOCK_SKEW_MS ||
    restoreVerifiedAt.valueOf() > nowMs + MAX_CLOCK_SKEW_MS ||
    nowMs - createdAt.valueOf() > MAX_PRESERVATION_EVIDENCE_AGE_MS ||
    nowMs - restoreVerifiedAt.valueOf() > MAX_PRESERVATION_EVIDENCE_AGE_MS
  ) {
    throw new Error(
      'Staging backup and restore evidence must be ordered and no older than 24 hours',
    )
  }

  return Object.freeze({
    archiveSha256: exactSha256(environment, 'PATHFINDER_STAGING_BACKUP_SHA256'),
    restoreProofSha256: exactSha256(environment, 'PATHFINDER_STAGING_BACKUP_RESTORE_PROOF_SHA256'),
    storageResource,
    ledgerCount,
    createdAt: createdAt.toISOString(),
    restoreVerifiedAt: restoreVerifiedAt.toISOString(),
  })
}

export function assertStagingMigrationAdmission(environment, now = new Date()) {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') {
    throw new Error('Staging migration requires RAILWAY_ENVIRONMENT=staging')
  }
  if (environment.PATHFINDER_ALLOW_STAGING_MIGRATIONS !== '1') {
    throw new Error('Staging migration requires PATHFINDER_ALLOW_STAGING_MIGRATIONS=1')
  }
  const dataPolicy = environment.PATHFINDER_CONFIRM_STAGING_DATA_POLICY
  if (!['synthetic-only', 'preserve-existing'].includes(dataPolicy)) {
    throw new Error('Staging migration data policy must be synthetic-only or preserve-existing')
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
  if (!/^[a-f0-9]{40}$/u.test(releaseSha)) {
    throw new Error('PATHFINDER_RELEASE_SHA must be a full Git commit SHA')
  }
  const providerReleaseSha = environment.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase()
  if (providerReleaseSha) {
    if (releaseSha !== providerReleaseSha) {
      throw new Error('PATHFINDER_RELEASE_SHA must equal the full Railway release commit SHA')
    }
  } else if (environment.PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL !== LOCAL_UPLOAD_APPROVAL) {
    throw new Error(
      'Local staging uploads require the exact one-time PATHFINDER_STAGING_LOCAL_UPLOAD_APPROVAL',
    )
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

  const backupEvidence =
    dataPolicy === 'preserve-existing'
      ? preservedDataEvidence(environment, { releaseSha, resource }, now)
      : null

  return Object.freeze({
    releaseSha,
    resource,
    databaseHost: pooled.host,
    directDatabaseHost: direct.host,
    database: pooled.database,
    spendCeilingUsd: spendCeiling,
    dataPolicy,
    backupEvidence,
  })
}

export const stagingMigrationPolicy = Object.freeze({
  maximumSpendUsd: MAX_APPROVED_STAGING_SPEND_USD,
  maximumPreservationEvidenceAgeMs: MAX_PRESERVATION_EVIDENCE_AGE_MS,
  productionProjectRefs: PRODUCTION_PROJECT_REFS,
})
