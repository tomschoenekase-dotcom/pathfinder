import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertSyntheticDestructiveFindings, runSyntheticHostedRehearsal, SYNTHETIC_DESTRUCTIVE_REVIEW_FIXTURE, validateSyntheticEvidence } from './synthetic-hosted-rehearsal.mjs'

const releaseSha = 'd'.repeat(40)
const hash = (value) => createHash('sha256').update(value).digest('hex')
const digestEvidence = (payload) => {
  const { integritySha256, ...unsigned } = payload
  return hash(JSON.stringify(unsigned))
}
const snapshot = (database) => ({ database, oid: 16384, ledger: ['20260101000000_fixture'], tableCount: 2, fixtureCount: 1, fixtureFingerprint: 'a'.repeat(32) })
function evidence() {
  const payload = {
    schemaVersion: 1, type: 'one-click-staging-synthetic', mode: 'synthetic-disposable', admission: 'synthetic-proof-only', releaseSha,
    createdAt: '2026-09-28T12:00:00.000Z', archiveSha256: 'b'.repeat(64), source: snapshot('pathfinder_disposable_source'),
    restore: { ...snapshot('pathfinder_disposable_restore'), archiveSha256: 'b'.repeat(64), ok: true },
    provenance: 'pending-github-oidc-attestation', integritySha256: '',
  }
  payload.integritySha256 = digestEvidence(payload)
  return payload
}

test('validates full evidence shape, preservation facts, archive binding and canonical digest', () => {
  const payload = evidence()
  assert.deepEqual(validateSyntheticEvidence(payload, releaseSha), { integritySha256: payload.integritySha256, archiveSha256: payload.archiveSha256 })
  assert.throws(() => validateSyntheticEvidence({ ...payload, releaseSha: 'f'.repeat(40) }, releaseSha), /evidence-sha-mismatch/u)
  assert.throws(() => validateSyntheticEvidence({ ...payload, integritySha256: '0'.repeat(64) }, releaseSha), /evidence-integrity-mismatch/u)
  assert.throws(() => validateSyntheticEvidence({ ...payload, restore: { ...payload.restore, fixtureFingerprint: 'c'.repeat(32) } }, releaseSha), /evidence-preservation-mismatch/u)
  assert.throws(() => validateSyntheticEvidence({ ...payload, restore: { ...payload.restore, archiveSha256: 'c'.repeat(64) } }, releaseSha), /evidence-restore-mismatch/u)
})

test('pinned synthetic destructive review rejects additional or changed findings', () => {
  const findings = SYNTHETIC_DESTRUCTIVE_REVIEW_FIXTURE.map(({ statementId, kind, sha256 }) => ({ statementId, kind, sha256 }))
  assert.equal(assertSyntheticDestructiveFindings(findings).length, 3)
  assert.throws(() => assertSyntheticDestructiveFindings([...findings, { statementId: 'new#1', kind: 'drop-or-truncate', sha256: 'f'.repeat(64) }]), /synthetic-migration-review-drift/u)
  assert.throws(() => assertSyntheticDestructiveFindings(findings.slice(1)), /synthetic-migration-review-drift/u)
  assert.throws(() => assertSyntheticDestructiveFindings([{ ...findings[0], sha256: '0'.repeat(64) }, ...findings.slice(1)]), /synthetic-migration-review-drift/u)
})

test('CLI composes pure checks and writes independently verifiable synthetic-only proof', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-hosted-rehearsal-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const input = evidence()
  const evidencePath = join(directory, 'evidence.json')
  const outputPath = join(directory, 'rehearsal-evidence.json')
  const bytes = `${JSON.stringify(input, null, 2)}\n`
  await writeFile(evidencePath, bytes)
  const env = { ...process.env, STAGING_SYNTHETIC_REHEARSAL: '1' }
  for (const key of ['STAGING_DATABASE_URL', 'DATABASE_URL', 'RAILWAY_TOKEN', 'RAILWAY_API_TOKEN', 'STAGING_BACKUP_PASSPHRASE', 'STAGING_RESTORE_DATABASE_URL', 'RESTORE_DATABASE_URL', 'STAGING_ARCHIVE_S3_ENDPOINT', 'STAGING_ARCHIVE_S3_BUCKET', 'STAGING_ARCHIVE_S3_REGION', 'STAGING_ARCHIVE_S3_ACCESS_KEY_ID', 'STAGING_ARCHIVE_S3_SECRET_ACCESS_KEY', 'STAGING_ARCHIVE_S3_SESSION_TOKEN', 'STAGING_BACKUP_PUBLIC_KEY']) delete env[key]
  const script = fileURLToPath(new URL('./synthetic-hosted-rehearsal.mjs', import.meta.url))
  const args = [script, '--synthetic-evidence', evidencePath, '--release-sha', releaseSha, '--output', outputPath]
  const run = spawnSync(process.execPath, args, { env, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const result = JSON.parse(await readFile(outputPath, 'utf8'))
  const { integritySha256, ...unsigned } = result
  assert.equal(integritySha256, hash(JSON.stringify(unsigned)))
  assert.equal(result.mode, 'synthetic-only')
  assert.equal(result.providerAccess, 'none')
  assert.equal(result.hostedAdmission, 'denied')
  assert.equal(result.releaseSha, releaseSha)
  assert.equal(result.inputEvidence.integritySha256, input.integritySha256)
  assert.equal(result.inputEvidence.fileSha256, hash(bytes))
  assert.equal(result.checks.baselineAcceptance, 'simulated-only-not-Tom-approval')
  assert.equal(result.checks.migrationReview, 'synthetic-only-pinned-fixture-simulated')
  assert.equal(result.checks.restoreProofSha256, hash(JSON.stringify(input.restore)))
  assert.doesNotMatch(JSON.stringify(result), /8621111a|a7a394fc|9fec9bdb|synthetic-fixture-resource/u)
  const changedEvidence = structuredClone(input)
  changedEvidence.source.fixtureFingerprint = 'f'.repeat(32)
  changedEvidence.restore.fixtureFingerprint = 'f'.repeat(32)
  changedEvidence.integritySha256 = digestEvidence(changedEvidence)
  assert.doesNotThrow(() => validateSyntheticEvidence(changedEvidence, releaseSha))
  await assert.rejects(runSyntheticHostedRehearsal({ evidence: changedEvidence, evidenceBytes: bytes, releaseSha }), /evidence-integrity-mismatch/u)
  const denied = spawnSync(process.execPath, [...args.slice(0, -1), join(directory, 'second.json')], { env: { ...env, STAGING_SYNTHETIC_REHEARSAL: '0' }, encoding: 'utf8' })
  assert.notEqual(denied.status, 0)
  assert.match(denied.stderr, /synthetic-rehearsal-opt-in-required/u)
})

test('rejects any real provider environment variable and reveals only its name', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'synthetic-hosted-rehearsal-env-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const evidencePath = join(directory, 'evidence.json')
  await writeFile(evidencePath, JSON.stringify(evidence()))
  const secretSentinel = 'must-never-appear-private-value'
  const publicKeySentinel = 'must-never-appear-public-key-value'
  const env = { ...process.env, STAGING_SYNTHETIC_REHEARSAL: '1', STAGING_ARCHIVE_S3_SECRET_ACCESS_KEY: secretSentinel, STAGING_BACKUP_PUBLIC_KEY: publicKeySentinel }
  const script = fileURLToPath(new URL('./synthetic-hosted-rehearsal.mjs', import.meta.url))
  const run = spawnSync(process.execPath, [script, '--synthetic-evidence', evidencePath, '--release-sha', releaseSha, '--output', join(directory, 'out.json')], { env, encoding: 'utf8' })
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /STAGING_ARCHIVE_S3_SECRET_ACCESS_KEY/u)
  assert.match(run.stderr, /STAGING_BACKUP_PUBLIC_KEY/u)
  assert.doesNotMatch(run.stderr, new RegExp(secretSentinel, 'u'))
  assert.doesNotMatch(run.stderr, new RegExp(publicKeySentinel, 'u'))
})
