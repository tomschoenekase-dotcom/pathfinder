import { createHash } from 'node:crypto'
import { compareTargetBaseline } from './target-baseline.mjs'

const HASH = /^[a-f0-9]{64}$/u
const RELEASE_SHA = /^[a-f0-9]{40}$/u
const MAX_PROOF_AGE_MS = 24 * 60 * 60 * 1_000
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000
const PREDECESSOR_COUNT = 250
const PREDECESSOR_FINAL_MIGRATION = '20260918190000_add_agent_routines'

export const ADMITTED_STAGING_MIGRATION_SUFFIX = Object.freeze([
  Object.freeze({
    name: '20260926120000_add_venue_distribution',
    checksum: '8095c4f833000986186bf09015e98ea0ad2d75de378589fb7a80dacb0175b518',
  }),
  Object.freeze({
    name: '20260927090000_add_venue_chat_appearance',
    checksum: '546ca0e09e90463be5d62710e191925481c83cd3c90633a310f63a26d4a489c5',
  }),
])

const fail = (code) => {
  throw new Error(code)
}
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex')

export function migrationSqlSha256(sql) {
  if (typeof sql !== 'string') fail('migration-policy-sql-required')
  return sha256(sql.replace(/\r\n/gu, '\n'))
}

function dollarTagAt(sql, index) {
  const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)
  return match?.[0] ?? null
}

function splitStatements(sql) {
  const out = []
  let start = 0
  let index = 0
  let state = 'normal'
  let blockDepth = 0
  let activeDollarTag = null
  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]
    if (state === 'single') {
      if (current === "'" && next === "'") index += 2
      else if (current === "'") {
        state = 'normal'
        index += 1
      } else if (current === '\\') index += 2
      else index += 1
      continue
    }
    if (state === 'double') {
      if (current === '"' && next === '"') index += 2
      else if (current === '"') {
        state = 'normal'
        index += 1
      } else index += 1
      continue
    }
    if (state === 'line-comment') {
      if (current === '\n') state = 'normal'
      index += 1
      continue
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1
        index += 2
      } else if (current === '*' && next === '/') {
        blockDepth -= 1
        index += 2
        if (blockDepth === 0) state = 'normal'
      } else index += 1
      continue
    }
    if (state === 'dollar') {
      if (sql.startsWith(activeDollarTag, index)) {
        index += activeDollarTag.length
        state = 'normal'
        activeDollarTag = null
      } else index += 1
      continue
    }
    if (current === '-' && next === '-') {
      state = 'line-comment'
      index += 2
      continue
    }
    if (current === '/' && next === '*') {
      state = 'block-comment'
      blockDepth = 1
      index += 2
      continue
    }
    if (current === "'") {
      state = 'single'
      index += 1
      continue
    }
    if (current === '"') {
      state = 'double'
      index += 1
      continue
    }
    if (current === '$') {
      const tag = dollarTagAt(sql, index)
      if (tag) {
        state = 'dollar'
        activeDollarTag = tag
        index += tag.length
        continue
      }
    }
    if (current === ';') {
      out.push(sql.slice(start, index))
      start = index + 1
    }
    index += 1
  }
  out.push(sql.slice(start))
  return out
    .map((source) => ({ source, detection: stripCommentsAndLiterals(source) }))
    .filter(({ detection }) => detection.trim().length > 0)
}

function stripCommentsAndLiterals(sql) {
  let out = ''
  let index = 0
  let state = 'normal'
  let blockDepth = 0
  let activeDollarTag = null
  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]
    if (state === 'single') {
      if (current === "'" && next === "'") index += 2
      else if (current === "'") {
        state = 'normal'
        out += ' '
        index += 1
      } else if (current === '\\') index += 2
      else index += 1
      continue
    }
    if (state === 'double') {
      if (current === '"' && next === '"') index += 2
      else if (current === '"') {
        state = 'normal'
        out += ' IDENT '
        index += 1
      } else index += 1
      continue
    }
    if (state === 'line-comment') {
      if (current === '\n') {
        state = 'normal'
        out += '\n'
      }
      index += 1
      continue
    }
    if (state === 'block-comment') {
      if (current === '/' && next === '*') {
        blockDepth += 1
        index += 2
      } else if (current === '*' && next === '/') {
        blockDepth -= 1
        index += 2
        if (blockDepth === 0) {
          state = 'normal'
          out += ' '
        }
      } else index += 1
      continue
    }
    if (state === 'dollar') {
      if (sql.startsWith(activeDollarTag, index)) {
        index += activeDollarTag.length
        state = 'normal'
        activeDollarTag = null
        out += ' '
      } else index += 1
      continue
    }
    if (current === '-' && next === '-') {
      state = 'line-comment'
      index += 2
      continue
    }
    if (current === '/' && next === '*') {
      state = 'block-comment'
      blockDepth = 1
      index += 2
      continue
    }
    if (current === "'") {
      state = 'single'
      out += ' '
      index += 1
      continue
    }
    if (current === '"') {
      state = 'double'
      index += 1
      continue
    }
    if (current === '$') {
      const tag = dollarTagAt(sql, index)
      if (tag) {
        state = 'dollar'
        activeDollarTag = tag
        out += ' '
        index += tag.length
        continue
      }
    }
    out += current
    index += 1
  }
  return out
}

function destructiveKind(statement) {
  const text = statement.trim().replace(/\s+/gu, ' ')
  if (/^(?:DO\b|CALL\b|EXECUTE\b|CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b|ALTER\s+(?:FUNCTION|PROCEDURE)\b)/iu.test(text)) {
    return 'procedural-sql'
  }
  if (
    /^(?:DROP\s+(?:TABLE|SCHEMA|DATABASE|TYPE|DOMAIN|VIEW|MATERIALIZED\s+VIEW|SEQUENCE|INDEX|FUNCTION|PROCEDURE|TRIGGER|EXTENSION)\b|TRUNCATE\b)/iu.test(
      text,
    )
  )
    return 'drop-or-truncate'
  if (
    /^DELETE\s+FROM\b/iu.test(text) ||
    (/^WITH\b/iu.test(text) && /\bDELETE\s+FROM\b/iu.test(text))
  )
    return 'delete'
  if (
    /^UPDATE\s+(?:ONLY\s+)?(?:IDENT\b|[A-Za-z_])/iu.test(text) ||
    (/^WITH\b/iu.test(text) && /\bUPDATE\s+(?:ONLY\s+)?(?:IDENT\b|[A-Za-z_])/iu.test(text))
  )
    return 'update'
  if (/^ALTER\s+(?:TABLE|TYPE|DOMAIN)\b[\s\S]*\bDROP\b/iu.test(text)) return 'alter-drop'
  return null
}

export function inspectDestructiveStatements(migrationName, sql) {
  if (typeof migrationName !== 'string' || typeof sql !== 'string')
    fail('migration-policy-sql-required')
  const findings = []
  splitStatements(sql).forEach(({ source, detection }, index) => {
    const kind = destructiveKind(detection)
    if (kind)
      findings.push({
        statementId: `${migrationName}#${index + 1}`,
        kind,
        sha256: migrationSqlSha256(source),
      })
  })
  return findings
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function validateSuffix(pendingMigrations, migrationSql) {
  if (
    !Array.isArray(pendingMigrations) ||
    !sameJson(pendingMigrations, ADMITTED_STAGING_MIGRATION_SUFFIX)
  ) {
    fail('migration-policy-suffix-not-admitted')
  }
  if (
    !Array.isArray(migrationSql) ||
    migrationSql.length !== ADMITTED_STAGING_MIGRATION_SUFFIX.length
  ) {
    fail('migration-policy-sql-suffix-mismatch')
  }
  migrationSql.forEach((migration, index) => {
    const admitted = ADMITTED_STAGING_MIGRATION_SUFFIX[index]
    if (
      migration?.migrationName !== admitted.name ||
      migrationSqlSha256(migration.sql) !== admitted.checksum
    ) {
      fail('migration-policy-sql-suffix-mismatch')
    }
  })
}

function validateReviews(findings, reviews) {
  if (!Array.isArray(reviews)) fail('migration-policy-review-required')
  const byId = new Map()
  const names = new Set()
  for (const review of reviews) {
    if (
      typeof review?.statementId !== 'string' ||
      typeof review?.statementName !== 'string' ||
      review.statementName.trim().length < 12
    )
      fail('migration-policy-review-name-required')
    if (!HASH.test(review.sha256)) fail('migration-policy-review-hash-mismatch')
    if (byId.has(review.statementId)) fail('migration-policy-duplicate-review')
    if (names.has(review.statementName.trim().toLowerCase()))
      fail('migration-policy-duplicate-review-name')
    byId.set(review.statementId, review)
    names.add(review.statementName.trim().toLowerCase())
  }
  for (const finding of findings) {
    const review = byId.get(finding.statementId)
    if (!review) fail('migration-policy-unreviewed-destructive-statement')
    if (review.sha256 !== finding.sha256) fail('migration-policy-review-hash-mismatch')
  }
  if (byId.size !== findings.length) fail('migration-policy-review-set-mismatch')
  for (const id of byId.keys()) {
    if (!findings.some((finding) => finding.statementId === id))
      fail('migration-policy-review-set-mismatch')
  }
}

function canonicalTime(value) {
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return null
  return Date.parse(value)
}

function validatePreservationProof(proof, { releaseSha, resourceId, ledgerCount, now }) {
  if (!proof || proof.verified !== true || proof.disposableRestoreVerified !== true)
    fail('migration-policy-backup-proof-required')
  if (
    !RELEASE_SHA.test(releaseSha) ||
    proof.releaseSha !== releaseSha ||
    proof.databaseResourceId !== resourceId
  ) {
    fail('migration-policy-backup-target-mismatch')
  }
  if (
    typeof proof.backupStorageResourceId !== 'string' ||
    !proof.backupStorageResourceId ||
    typeof proof.disposableDatabaseResourceId !== 'string' ||
    !proof.disposableDatabaseResourceId ||
    proof.backupStorageResourceId === resourceId ||
    proof.disposableDatabaseResourceId === resourceId ||
    proof.disposableDatabaseResourceId === proof.backupStorageResourceId
  )
    fail('migration-policy-backup-target-mismatch')
  if (
    !HASH.test(proof.archiveSha256) ||
    !HASH.test(proof.restoreProofSha256) ||
    proof.ledgerCount !== ledgerCount
  ) {
    fail('migration-policy-backup-proof-invalid')
  }
  const createdAt = canonicalTime(proof.createdAt)
  const restoredAt = canonicalTime(proof.restoreVerifiedAt)
  const currentTime = canonicalTime(now)
  if (
    createdAt === null ||
    restoredAt === null ||
    currentTime === null ||
    createdAt > restoredAt ||
    createdAt > currentTime + MAX_CLOCK_SKEW_MS ||
    restoredAt > currentTime + MAX_CLOCK_SKEW_MS ||
    currentTime - createdAt > MAX_PROOF_AGE_MS ||
    currentTime - restoredAt > MAX_PROOF_AGE_MS
  ) {
    fail('migration-policy-backup-proof-stale')
  }
}

/**
 * `reviewedDestructiveStatements` must come from the accepted release card. This
 * pure contract validates each unique name and exact statement digest but does not
 * read or attest that external card. It never connects to a database,
 * reads credentials, writes files, or authorizes hosted execution.
 */
export function evaluatePreserveExistingMigration(input) {
  try {
    compareTargetBaseline(input?.targetBaseline, input?.observedTarget)
  } catch {
    fail('migration-policy-target-baseline-rejected')
  }
  if (input?.unresolvedMigrationAttempts !== 0) fail('migration-policy-unresolved-attempts')
  if (
    input.targetBaseline.finishedMigrations.length !== PREDECESSOR_COUNT ||
    input.targetBaseline.finishedMigrations.at(-1)?.name !== PREDECESSOR_FINAL_MIGRATION
  ) {
    fail('migration-policy-predecessor-not-admitted')
  }
  validateSuffix(input.pendingMigrations, input.migrationSql)
  validatePreservationProof(input.preservationProof, {
    releaseSha: input.releaseSha,
    resourceId: input.targetBaseline.target.railwayDatabaseResourceId,
    ledgerCount: input.targetBaseline.finishedMigrations.length,
    now: input.now,
  })
  const findings = input.migrationSql.flatMap(({ migrationName, sql }) =>
    inspectDestructiveStatements(migrationName, sql),
  )
  validateReviews(findings, input.reviewedDestructiveStatements)
  return {
    ok: true,
    executionScope: 'disposable-preflight-only',
    hostedExecutionAllowed: false,
    admittedMigrationNames: ADMITTED_STAGING_MIGRATION_SUFFIX.map(({ name }) => name),
  }
}
