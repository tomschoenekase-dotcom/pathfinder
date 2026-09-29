import { createHash } from 'node:crypto'

const HEX_SHA256 = /^[a-f0-9]{64}$/u
const MIGRATION_NAME = /^[0-9]{14}_[a-z0-9_]+$/u
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u

const fail = (code) => {
  throw new Error(code)
}
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

export const targetBaselineSql = Object.freeze({
  /** Execute only inside a repeatable-read, read-only transaction. */
  begin: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  systemIdentity: `SELECT pg_control_system().system_identifier::text AS system_identifier,
       database.oid::text AS database_oid,
       database.datname AS database_name
FROM pg_database AS database
WHERE database.datname = current_database()`,
  finishedMigrations: `SELECT migration_name, checksum
FROM "_prisma_migrations"
WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
ORDER BY migration_name`,
  unresolvedMigrationAttempts: `SELECT count(*)::text AS unresolved_count
FROM "_prisma_migrations"
WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL OR logs IS NOT NULL`,
  tableInventory: `SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name <> '_prisma_migrations'
ORDER BY table_schema, table_name`,
  commit: 'COMMIT',
})

function decimal(value, { max = null, allowZero = false } = {}) {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(text)) return null
  let integer
  try {
    integer = BigInt(text)
  } catch {
    return null
  }
  if ((!allowZero && integer === 0n) || (max !== null && integer > BigInt(max))) return null
  return text
}

function normalizedTarget(observation) {
  const resourceId = observation?.railwayDatabaseResourceId
  const systemIdentifier = decimal(observation?.systemIdentifier)
  const databaseOid = decimal(observation?.databaseOid, { max: 4_294_967_295 })
  const databaseName = observation?.databaseName
  if (
    typeof resourceId !== 'string' ||
    resourceId.length < 1 ||
    resourceId.length > 256 ||
    /[\s\u0000-\u001f]/u.test(resourceId) ||
    !systemIdentifier ||
    !databaseOid ||
    typeof databaseName !== 'string' ||
    !SAFE_IDENTIFIER.test(databaseName)
  ) {
    fail('invalid-target-observation')
  }
  return { railwayDatabaseResourceId: resourceId, systemIdentifier, databaseOid, databaseName }
}

function normalizedLedger(ledger) {
  if (!Array.isArray(ledger) || ledger.length === 0) fail('invalid-target-observation')
  const normalized = []
  const seen = new Set()
  let previous = ''
  for (const row of ledger) {
    if (
      !row ||
      typeof row !== 'object' ||
      !MIGRATION_NAME.test(row.name) ||
      !HEX_SHA256.test(row.checksum) ||
      seen.has(row.name) ||
      (previous && row.name <= previous)
    )
      fail('invalid-target-observation')
    normalized.push({ name: row.name, checksum: row.checksum })
    previous = row.name
    seen.add(row.name)
  }
  return normalized
}

function normalizedTableCounts(tableCounts) {
  if (!Array.isArray(tableCounts) || tableCounts.length === 0) fail('invalid-target-observation')
  const rows = tableCounts
    .map((row) => {
      const count = decimal(row?.rowCount, { allowZero: true })
      if (
        row?.schema !== 'public' ||
        typeof row?.tableName !== 'string' ||
        !SAFE_IDENTIFIER.test(row.tableName) ||
        row.tableName === '_prisma_migrations' ||
        count === null
      )
        fail('invalid-target-observation')
      return { schema: row.schema, tableName: row.tableName, rowCount: count }
    })
    .sort((a, b) => a.schema.localeCompare(b.schema) || a.tableName.localeCompare(b.tableName))
  for (let index = 1; index < rows.length; index += 1) {
    if (
      rows[index - 1].schema === rows[index].schema &&
      rows[index - 1].tableName === rows[index].tableName
    ) {
      fail('invalid-target-observation')
    }
  }
  return rows
}

export function migrationLedgerSha256(ledger) {
  return sha256(JSON.stringify(normalizedLedger(ledger)))
}

export function tableCountsSha256(tableCounts) {
  return sha256(JSON.stringify(normalizedTableCounts(tableCounts)))
}

export function exactTableCountSql(schema, tableName) {
  if (
    schema !== 'public' ||
    typeof tableName !== 'string' ||
    !SAFE_IDENTIFIER.test(tableName) ||
    tableName === '_prisma_migrations'
  ) {
    fail('invalid-table-identity')
  }
  const quote = (identifier) => `"${identifier.replaceAll('"', '""')}"`
  return `SELECT count(*)::text AS row_count FROM ${quote(schema)}.${quote(tableName)}`
}

function normalizedObservation(observation) {
  if (observation?.unresolvedMigrationAttempts !== 0) fail('invalid-target-observation')
  const target = normalizedTarget(observation)
  const finishedMigrations = normalizedLedger(observation.finishedMigrations)
  const tableRowCounts = normalizedTableCounts(observation.tableRowCounts)
  return {
    target,
    finishedMigrations,
    finishedMigrationLedgerSha256: sha256(JSON.stringify(finishedMigrations)),
    tableRowCounts,
    tableCountsSha256: sha256(JSON.stringify(tableRowCounts)),
    unresolvedMigrationAttempts: 0,
  }
}

export function buildProposedTargetBaseline(observation) {
  const normalized = normalizedObservation(observation)
  return {
    schemaVersion: 1,
    type: 'torchiko-staging-target-baseline',
    status: 'proposed',
    ...normalized,
  }
}

function assertAcceptedBaseline(baseline) {
  if (baseline === null || baseline === undefined) fail('target-baseline-missing')
  if (baseline?.type !== 'torchiko-staging-target-baseline' || baseline?.schemaVersion !== 1) {
    fail('invalid-target-baseline')
  }
  if (baseline.status !== 'accepted') fail('target-baseline-not-accepted')
  const acceptance = baseline.acceptance
  if (
    acceptance?.approvedBy !== 'Tom' ||
    typeof acceptance.approvedAt !== 'string' ||
    !Number.isFinite(Date.parse(acceptance.approvedAt)) ||
    new Date(acceptance.approvedAt).toISOString() !== acceptance.approvedAt
  ) {
    fail('invalid-target-baseline')
  }
  const normalized = normalizedObservation({
    ...baseline.target,
    finishedMigrations: baseline.finishedMigrations,
    tableRowCounts: baseline.tableRowCounts,
    unresolvedMigrationAttempts: baseline.unresolvedMigrationAttempts,
  })
  if (
    baseline.finishedMigrationLedgerSha256 !== normalized.finishedMigrationLedgerSha256 ||
    baseline.tableCountsSha256 !== normalized.tableCountsSha256
  )
    fail('invalid-target-baseline')
  return normalized
}

/** Compare identities and aggregate-only state. This function never opens a connection. */
export function compareTargetBaseline(baseline, observation) {
  const expected = assertAcceptedBaseline(baseline)
  const actual = normalizedObservation(observation)
  if (JSON.stringify(expected) !== JSON.stringify(actual)) fail('target-baseline-mismatch')
  return { ok: true, comparison: 'exact-target-and-aggregate-state' }
}
