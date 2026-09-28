import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

const hex40 = /^[0-9a-f]{40}$/u
const hex64 = /^[0-9a-f]{64}$/u

export function assertAuthenticatedMetadata(manifest) {
  const expected = { schemaVersion: manifest?.schemaVersion, mode: manifest?.mode, source: manifest?.source }
  if (Object.hasOwn(manifest?.authenticatedMetadata ?? {}, 'plaintextBytes')) expected.plaintextBytes = manifest.plaintextBytes
  assert.deepStrictEqual(manifest?.authenticatedMetadata, expected)
}

export function assertArtifactBinding(encrypted, manifest, evidence) {
  const digest = createHash('sha256').update(encrypted).digest('hex')
  if (!hex64.test(manifest?.archiveSha256 ?? '') || !hex64.test(evidence?.archiveSha256 ?? '') ||
      digest !== manifest.archiveSha256 || digest !== evidence.archiveSha256) {
    throw new Error('artifact-binding-mismatch')
  }
  try { assert.deepStrictEqual(manifest.source, evidence.source) } catch { throw new Error('artifact-source-mismatch') }
  return { archiveSha256: digest }
}

export function assertSourceRun(run, releaseSha) {
  if (!hex40.test(releaseSha ?? '') || run?.path !== '.github/workflows/staging-release.yml' ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.head_sha !== releaseSha ||
      run.head_branch !== 'master' || run.conclusion !== 'success') {
    throw new Error('untrusted-source-run')
  }
  return { headSha: releaseSha, branch: 'master' }
}
