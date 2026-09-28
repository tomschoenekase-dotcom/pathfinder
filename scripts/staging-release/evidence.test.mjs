import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

const root = process.env.STAGING_RELEASE_TMP
if (!root) throw new Error('STAGING_RELEASE_TMP must name a task-owned temporary directory')
const sha = 'a'.repeat(40)
const archiveSha256 = 'b'.repeat(64)
const source = { database: 'pathfinder_disposable_source', oid: '16384', ledger: ['synthetic_fixture_001'], tableCount: 2, fixtureCount: 1, fixtureFingerprint: 'c'.repeat(32) }
const restored = { ...source, database: 'pathfinder_disposable_restore', oid: '24576' }

function cli(args) { return spawnSync(process.execPath, ['scripts/staging-release/evidence.mjs', ...args], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' }) }

test('synthetic evidence validates and rejects tampering, wrong SHA and lost preservation', async () => {
  const dir = await mkdtemp(path.join(root, 'evidence-test-'))
  try {
    const manifest = path.join(dir, 'backup-manifest.json')
    const proof = path.join(dir, 'restore-proof.json')
    const output = path.join(dir, 'evidence.json')
    await writeFile(manifest, JSON.stringify({ schemaVersion: 1, mode: 'synthetic-disposable', archiveSha256, source }))
    await writeFile(proof, JSON.stringify({ schemaVersion: 1, mode: 'synthetic-disposable', archiveSha256, restored, ok: true }))
    assert.equal(cli(['--backup-manifest', manifest, '--restore-proof', proof, '--release-sha', sha, '--output', output]).status, 0)
    assert.equal(cli(['--verify', output, '--release-sha', sha]).status, 0)
    assert.equal(cli(['--verify', output, '--release-sha', 'd'.repeat(40)]).status, 1)
    const original = JSON.parse(await readFile(output, 'utf8'))
    const evidence = structuredClone(original)
    evidence.createdAt = '2026-09-27T00:00:00.000Z'
    await writeFile(output, JSON.stringify(evidence))
    assert.equal(cli(['--verify', output, '--release-sha', sha]).status, 1)
    evidence.restore.fixtureCount = 2
    delete evidence.integritySha256
    evidence.integritySha256 = createHash('sha256').update(JSON.stringify(evidence)).digest('hex')
    await writeFile(output, JSON.stringify(evidence))
    assert.equal(cli(['--verify', output, '--release-sha', sha]).status, 1)
    const malformed = structuredClone(original)
    malformed.source.tableCount = '2'
    delete malformed.integritySha256
    malformed.integritySha256 = createHash('sha256').update(JSON.stringify(malformed)).digest('hex')
    await writeFile(output, JSON.stringify(malformed))
    assert.equal(cli(['--verify', output, '--release-sha', sha]).status, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('synthetic evidence policy explicitly cannot admit hosted staging', async () => {
  const policyPath = new URL('../release-verification-policy.json', import.meta.url)
  const policy = JSON.parse(await readFile(policyPath, 'utf8'))
  assert.deepEqual(policy.oneClickStaging, {
    syntheticEvidenceType: 'one-click-staging-synthetic',
    syntheticSchemaVersion: 1,
    syntheticAdmission: 'synthetic-proof-only',
    signedProvenance: 'GitHub OIDC artifact attestation on evidence.json',
    hostedReleaseAdmittedBySyntheticEvidence: false,
  })
})
