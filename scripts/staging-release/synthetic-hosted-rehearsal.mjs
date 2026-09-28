import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectDestructiveStatements, ADMITTED_STAGING_MIGRATION_SUFFIX, evaluatePreserveExistingMigration } from './migration-policy.mjs'
import { runStagingDeploy, STAGING_DEPLOY_SERVICES, STAGING_DEPLOY_TARGET } from './railway-deploy.mjs'
import { assertWriterHold } from './writer-hold.mjs'
import { buildProposedTargetBaseline, compareTargetBaseline } from './target-baseline.mjs'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const FULL_SHA = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '../..')

// Presence alone is enough to reject. Never inspect or include a value in an error.
const REAL_PROVIDER_VARS = Object.freeze([
  'STAGING_DATABASE_URL', 'DATABASE_URL', 'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN',
  'STAGING_BACKUP_PASSPHRASE', 'STAGING_RESTORE_DATABASE_URL', 'RESTORE_DATABASE_URL',
  'STAGING_ARCHIVE_S3_ENDPOINT', 'STAGING_ARCHIVE_S3_BUCKET', 'STAGING_ARCHIVE_S3_REGION',
  'STAGING_ARCHIVE_S3_ACCESS_KEY_ID', 'STAGING_ARCHIVE_S3_SECRET_ACCESS_KEY', 'STAGING_ARCHIVE_S3_SESSION_TOKEN',
  'STAGING_BACKUP_PUBLIC_KEY',
])

// This is only a synthetic rehearsal fixture for the currently admitted SQL.
// It cannot represent a release-card review or Tom's acceptance.
export const SYNTHETIC_DESTRUCTIVE_REVIEW_FIXTURE = Object.freeze([
  Object.freeze({ statementId: '20260926120000_add_venue_distribution#4', kind: 'alter-drop', sha256: 'f86287f1fc14ce4f299e4eeed9ebd3845f9c9e43b7a62c71307c5eaddd4b98c6', statementName: 'Synthetic fixture review of admitted venue distribution constraint change' }),
  Object.freeze({ statementId: '20260926120000_add_venue_distribution#6', kind: 'alter-drop', sha256: '491248e580ec719816d4725ebe8f19a7008bba80a56ddb863f774a856a1b9e83', statementName: 'Synthetic fixture review of admitted venue distribution type change' }),
  Object.freeze({ statementId: '20260926120000_add_venue_distribution#20', kind: 'procedural-sql', sha256: '89c2ada8185028fa71784818f5f0e8d412fd963ccff25341f23e1c2c318522af', statementName: 'Synthetic fixture review of admitted venue distribution procedure' }),
])

function fail(code) { throw new Error(code) }

export function assertSyntheticDestructiveFindings(findings) {
  const actual = findings.map(({ statementId, kind, sha256 }) => ({ statementId, kind, sha256 }))
  const expected = SYNTHETIC_DESTRUCTIVE_REVIEW_FIXTURE.map(({ statementId, kind, sha256 }) => ({ statementId, kind, sha256 }))
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('synthetic-migration-review-drift')
  return SYNTHETIC_DESTRUCTIVE_REVIEW_FIXTURE.map(({ statementId, statementName, sha256 }) => ({ statementId, statementName, sha256 }))
}

function parseArgs(args) {
  const options = new Map()
  if (args.length !== 6) fail('invalid-rehearsal-arguments')
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    if (!['--synthetic-evidence', '--release-sha', '--output'].includes(key) || options.has(key) || !args[i + 1]) fail('invalid-rehearsal-arguments')
    options.set(key, args[i + 1])
  }
  if (options.size !== 3) fail('invalid-rehearsal-arguments')
  return options
}

function evidenceDigest(payload) {
  const { integritySha256, ...unsigned } = payload
  return sha256(JSON.stringify(unsigned))
}

/** Validate all fields used by the production synthetic-evidence contract. */
export function validateSyntheticEvidence(payload, releaseSha) {
  if (!FULL_SHA.test(releaseSha ?? '')) fail('invalid-release-sha')
  if (payload?.schemaVersion !== 1 || payload?.type !== 'one-click-staging-synthetic' ||
      payload?.mode !== 'synthetic-disposable' || payload?.admission !== 'synthetic-proof-only') fail('wrong-evidence-type')
  if (payload.releaseSha !== releaseSha) fail('evidence-sha-mismatch')
  if (!HASH.test(payload.archiveSha256 ?? '') || payload.restore?.archiveSha256 !== payload.archiveSha256 || payload.restore?.ok !== true) fail('evidence-restore-mismatch')
  const validSnapshot = (snapshot, database) => snapshot && !Array.isArray(snapshot) && typeof snapshot === 'object' &&
    snapshot.database === database && ((Number.isSafeInteger(snapshot.oid) && snapshot.oid > 0) ||
      (typeof snapshot.oid === 'string' && /^[1-9][0-9]*$/u.test(snapshot.oid) && Number.isSafeInteger(Number(snapshot.oid)))) &&
    Array.isArray(snapshot.ledger) && snapshot.ledger.length > 0 && snapshot.ledger.every((x) => typeof x === 'string' && /^[a-z0-9_]+$/u.test(x)) &&
    Number.isSafeInteger(snapshot.tableCount) && snapshot.tableCount >= 2 && Number.isSafeInteger(snapshot.fixtureCount) && snapshot.fixtureCount >= 1 &&
    typeof snapshot.fixtureFingerprint === 'string' && /^[a-f0-9]{32}$/u.test(snapshot.fixtureFingerprint)
  const source = payload.source
  const restored = payload.restore
  if (!validSnapshot(source, 'pathfinder_disposable_source') || !validSnapshot(restored, 'pathfinder_disposable_restore')) fail('evidence-database-mismatch')
  if (source.ledger.length !== restored.ledger.length || source.ledger.some((name, i) => name !== restored.ledger[i]) ||
      source.tableCount !== restored.tableCount || source.fixtureCount !== restored.fixtureCount ||
      source.fixtureFingerprint !== restored.fixtureFingerprint) fail('evidence-preservation-mismatch')
  if (typeof payload.createdAt !== 'string' || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) fail('evidence-timestamp-invalid')
  if (payload.provenance !== 'pending-github-oidc-attestation') fail('evidence-provenance-invalid')
  if (!HASH.test(payload.integritySha256 ?? '') || evidenceDigest(payload) !== payload.integritySha256) fail('evidence-integrity-mismatch')
  return { integritySha256: payload.integritySha256, archiveSha256: payload.archiveSha256 }
}

function acceptedFixtureBaseline() {
  const ledger = Array.from({ length: 249 }, (_, index) => ({
    name: `20260101${String(index).padStart(6, '0')}_fixture_${String(index).padStart(3, '0')}`,
    checksum: 'a'.repeat(64),
  }))
  ledger.push({ name: '20260918190000_add_agent_routines', checksum: 'e'.repeat(64) })
  const observation = {
    railwayDatabaseResourceId: 'synthetic-fixture-resource', systemIdentifier: '739184002001', databaseOid: 16384,
    databaseName: 'pathfinder_staging_fixture', finishedMigrations: ledger,
    tableRowCounts: [{ schema: 'public', tableName: 'venues', rowCount: '12' }], unresolvedMigrationAttempts: 0,
  }
  return { observation, baseline: { ...buildProposedTargetBaseline(observation), status: 'accepted', acceptance: { approvedBy: 'Tom', approvedAt: '2026-09-27T12:00:00.000Z' } } }
}

function mockWriterReceipt(now) {
  const earlierAt = new Date(now - 60_000).toISOString()
  const laterAt = new Date(now - 10_000).toISOString()
  return {
    projectId: STAGING_DEPLOY_TARGET.projectId, environmentId: STAGING_DEPLOY_TARGET.environmentId,
    maintenance: { enabled: true, ingressPaused: true, automaticReleaseAt: new Date(now + 5 * 60_000).toISOString() },
    services: Object.fromEntries(Object.keys(STAGING_DEPLOY_SERVICES).map((name) => [name, 0])),
    samples: [earlierAt, laterAt].map((at) => ({ at, queueRows: 0, auditRows: 0 })),
  }
}

function mockDeployAdapter(releaseSha) {
  const ids = { 'staging-web': '11111111-1111-4111-8111-111111111111', 'staging-dashboard': '22222222-2222-4222-8222-222222222222', 'staging-workers': '33333333-3333-4333-8333-333333333333' }
  return {
    kind: 'mock',
    async readTarget() { return { ...STAGING_DEPLOY_TARGET, services: { ...STAGING_DEPLOY_SERVICES } } },
    async deploy({ serviceName }) { return { deploymentId: ids[serviceName] } },
    async readDeployment(request) { return { ...request, status: 'SUCCESS', sourceSha: releaseSha } },
    async readHealth(request) { return { ...request, healthy: true, revision: releaseSha } },
  }
}

export async function runSyntheticHostedRehearsal({ evidence, evidenceBytes, releaseSha }) {
  const evidenceFacts = validateSyntheticEvidence(evidence, releaseSha)
  if (typeof evidenceBytes !== 'string' || evidenceBytes.length === 0) fail('evidence-integrity-mismatch')
  let parsedEvidence
  try { parsedEvidence = JSON.parse(evidenceBytes) } catch { fail('evidence-integrity-mismatch') }
  if (JSON.stringify(parsedEvidence) !== JSON.stringify(evidence)) fail('evidence-integrity-mismatch')
  const restoreProofSha256 = sha256(JSON.stringify(evidence.restore))
  const now = Date.now()
  const { baseline, observation } = acceptedFixtureBaseline()
  compareTargetBaseline(baseline, observation)
  const migrationSql = await Promise.all(ADMITTED_STAGING_MIGRATION_SUFFIX.map(async ({ name }) => ({
    migrationName: name,
    sql: await readFile(resolve(repoRoot, 'packages/db/prisma/migrations', name, 'migration.sql'), 'utf8'),
  })))
  const findings = migrationSql.flatMap(({ migrationName, sql }) => inspectDestructiveStatements(migrationName, sql))
  const reviews = assertSyntheticDestructiveFindings(findings)
  const policy = evaluatePreserveExistingMigration({
    targetBaseline: baseline, observedTarget: observation, unresolvedMigrationAttempts: 0,
    releaseSha, now: new Date(now).toISOString(), pendingMigrations: ADMITTED_STAGING_MIGRATION_SUFFIX, migrationSql,
    reviewedDestructiveStatements: reviews,
    preservationProof: {
      verified: true, disposableRestoreVerified: true, releaseSha,
      databaseResourceId: observation.railwayDatabaseResourceId,
      backupStorageResourceId: 'synthetic-fixture-backup', disposableDatabaseResourceId: 'synthetic-fixture-restore',
      createdAt: new Date(now - 60_000).toISOString(), restoreVerifiedAt: new Date(now - 30_000).toISOString(),
      archiveSha256: evidenceFacts.archiveSha256, restoreProofSha256, ledgerCount: 250,
    },
  })
  const hold = assertWriterHold(mockWriterReceipt(now), now)
  const deploy = await runStagingDeploy({ releaseSha, adapter: mockDeployAdapter(releaseSha), pollIntervalMs: 0, sleep: async () => {} })
  if (!policy.ok || policy.hostedExecutionAllowed !== false || !hold.ok || !deploy.ok || deploy.revision !== releaseSha ||
      Object.keys(deploy.services).length !== 3 || Object.values(deploy.services).some((service) => service.revision !== releaseSha || service.healthy !== true)) fail('rehearsal-admission-check-failed')
  const artifact = {
    schemaVersion: 1,
    type: 'torchiko-synthetic-hosted-rehearsal',
    mode: 'synthetic-only',
    providerAccess: 'none',
    hostedAdmission: 'denied',
    releaseSha,
    inputEvidence: { type: evidence.type, integritySha256: evidenceFacts.integritySha256, fileSha256: sha256(Buffer.from(evidenceBytes, 'utf8')) },
    checks: { evidenceShapeAndIntegrity: true, targetBaseline: 'synthetic-fixture-exact', baselineAcceptance: 'simulated-only-not-Tom-approval', restoreProofSha256, migrationReview: 'synthetic-only-pinned-fixture-simulated', writerReceipt: 'mock-verified', threeServiceSameShaHealth: 'mock-verified' },
    integritySha256: '',
  }
  const { integritySha256, ...unsigned } = artifact
  artifact.integritySha256 = sha256(JSON.stringify(unsigned))
  return artifact
}

async function main() {
  if (process.env.STAGING_SYNTHETIC_REHEARSAL !== '1') fail('synthetic-rehearsal-opt-in-required')
  const present = REAL_PROVIDER_VARS.filter((name) => Object.hasOwn(process.env, name))
  if (present.length) fail(`real-provider-environment-present:${present.join(',')}`)
  const options = parseArgs(process.argv.slice(2))
  const releaseSha = options.get('--release-sha')
  if (!FULL_SHA.test(releaseSha ?? '')) fail('invalid-release-sha')
  const evidenceBytes = await readFile(options.get('--synthetic-evidence'))
  const evidence = JSON.parse(evidenceBytes.toString('utf8'))
  const artifact = await runSyntheticHostedRehearsal({ evidence, evidenceBytes: evidenceBytes.toString('utf8'), releaseSha })
  const output = resolve(options.get('--output'))
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return { ok: true, type: artifact.type, releaseSha, integritySha256: artifact.integritySha256 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((result) => process.stdout.write(`${JSON.stringify(result)}\n`)).catch((error) => {
    const code = typeof error?.message === 'string' && /^[A-Za-z0-9_:,\-]+$/u.test(error.message) ? error.message : 'synthetic-hosted-rehearsal-failed'
    process.stderr.write(`${JSON.stringify({ ok: false, code })}\n`)
    process.exitCode = 1
  })
}
