import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { assertArtifactBinding, assertAuthenticatedMetadata, assertSourceRun } from './restore-provenance.mjs'

const sha = 'a'.repeat(40)
const digest = createHash('sha256').update('archive').digest('hex')
const source = { database: 'pathfinder_disposable_source', ledger: ['synthetic_fixture_001'] }
const manifest = { archiveSha256: digest, source }
const evidence = { archiveSha256: digest, source }

test('artifact binding refuses an archive substituted after evidence was signed', () => {
  assert.deepEqual(assertArtifactBinding(Buffer.from('archive'), manifest, evidence), { archiveSha256: evidence.archiveSha256 })
  assert.throws(() => assertArtifactBinding(Buffer.from('forged'), manifest, evidence), /artifact-binding-mismatch/u)
  assert.throws(() => assertArtifactBinding(Buffer.from('archive'), manifest, { ...evidence, archiveSha256: 'c'.repeat(64) }), /artifact-binding-mismatch/u)
  assert.throws(() => assertArtifactBinding(Buffer.from('archive'), manifest, { ...evidence, source: { ...source, ledger: ['other'] } }), /artifact-source-mismatch/u)
})

test('source run must be a successful exact SHA on the trusted workflow and branch', () => {
  const run = { path: '.github/workflows/staging-release.yml', event: 'push', head_sha: sha, head_branch: 'master', conclusion: 'success' }
  assert.deepEqual(assertSourceRun(run, sha), { headSha: sha, branch: 'master' })
  for (const changed of [
    { path: '.github/workflows/ci.yml' }, { event: 'pull_request' },
    { head_sha: 'c'.repeat(40) }, { head_branch: 'other' }, { conclusion: 'failure' },
  ]) assert.throws(() => assertSourceRun({ ...run, ...changed }, sha), /untrusted-source-run/u)
})

test('streamed and earlier buffered archives bind their authenticated metadata', () => {
  const base = { schemaVersion: 1, mode: 'synthetic-disposable', source: { database: 'synthetic' }, plaintextBytes: 100 }
  assert.doesNotThrow(() => assertAuthenticatedMetadata({ ...base, authenticatedMetadata: {
    schemaVersion: 1, mode: 'synthetic-disposable', source: base.source,
  } }))
  assert.doesNotThrow(() => assertAuthenticatedMetadata({ ...base, authenticatedMetadata: {
    schemaVersion: 1, mode: 'synthetic-disposable', source: base.source, plaintextBytes: 100,
  } }))
  assert.throws(() => assertAuthenticatedMetadata({ ...base, authenticatedMetadata: {
    schemaVersion: 1, mode: 'synthetic-disposable', source: base.source, plaintextBytes: 101,
  } }))
})
