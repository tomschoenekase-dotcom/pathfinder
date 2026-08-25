import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import path from 'node:path'

import { prepareReleaseEvidencePayload } from './lib/release-evidence-payload.mjs'

const repositoryRoot = path.resolve('fixture-repository')
const assessmentPath = path.join(repositoryRoot, 'artifacts/release-verification/candidate.json')
const handoffPath = path.join(repositoryRoot, 'artifacts/staging-handoff/candidate.json')
const revision = 'a'.repeat(40)
const assessment = {
  schemaVersion: 1,
  generatedAt: '2026-08-25T00:00:00.000Z',
  revision,
  profile: 'candidate',
  readiness: 'ready-for-staging-review',
  repository: { clean: true },
  summary: { passed: 1, failed: 0, blocked: 0 },
  gates: [{ id: 'test', status: 'pass', durationMs: 1 }],
  limitations: [],
  rollback: { application: 'redeploy', database: 'forward fix', runbook: 'runbook.md' },
}
const assessmentBytes = Buffer.from(JSON.stringify(assessment))
const assessmentSha256 = createHash('sha256').update(assessmentBytes).digest('hex')
const handoff = {
  schemaVersion: 1,
  kind: 'torchiko-staging-handoff',
  base: { revision: 'b'.repeat(40) },
  candidate: { revision, clean: true },
  lineage: { baseIsAncestor: true, ahead: 1, behind: 0 },
  delta: { changedFiles: 2, patchSha256: 'c'.repeat(64) },
  releaseVerification: {
    sha256: assessmentSha256,
    readiness: assessment.readiness,
    ...assessment.summary,
  },
  database: { count: 3, latest: 'migration', chainSha256: 'd'.repeat(64) },
  admission: {
    status: 'ready-for-owner-staging-integration',
    requiredActions: ['review'],
    retainedGates: ['no production'],
  },
}
const handoffBytes = Buffer.from(JSON.stringify(handoff))

test('projects exact release and handoff artifacts into a deterministic bounded payload', () => {
  const first = prepareReleaseEvidencePayload({
    assessment,
    assessmentBytes,
    assessmentPath,
    handoff,
    handoffBytes,
    handoffPath,
    repositoryRoot,
  })
  const second = prepareReleaseEvidencePayload({
    assessment,
    assessmentBytes,
    assessmentPath,
    handoff,
    handoffBytes,
    handoffPath,
    repositoryRoot,
  })
  assert.deepEqual(first, second)
  assert.match(first.operationId, /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
  assert.equal(first.stagingHandoff.artifactSha256, createHash('sha256').update(handoffBytes).digest('hex'))
  assert.equal(first.stagingHandoff.migrationCount, 3)
  assert.equal(first.sourceReference, 'artifacts/release-verification/candidate.json + artifacts/staging-handoff/candidate.json')
})

test('rejects a handoff that points at different assessment bytes', () => {
  assert.throws(
    () =>
      prepareReleaseEvidencePayload({
        assessment,
        assessmentBytes: Buffer.from(`${assessmentBytes} `),
        assessmentPath,
        handoff,
        handoffBytes,
        handoffPath,
        repositoryRoot,
      }),
    /assessment-digest-mismatch/u,
  )
})

