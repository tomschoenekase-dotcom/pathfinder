import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_EVIDENCE_BYTES,
  MAX_LOG_BYTES,
  parseBoundedEvidence,
  parseTrustedAdmissionLog,
  selectTrustedRun,
  verifyPromotionAdmissionEvidence,
} from './lib/promotion-admission-evidence.mjs'
import { STAGING_RELEASE_TARGET } from './lib/staging-release-admission.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const REPOSITORY = 'owner/repository'
const NOW = Date.parse('2026-10-03T12:30:00.000Z')

function fixture() {
  const run = {
    id: 123,
    workflow_id: 42,
    path: '.github/workflows/staging-admission.yml',
    name: 'Staging deployment admission',
    event: 'workflow_run',
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: REPOSITORY },
    head_repository: { full_name: REPOSITORY },
    created_at: '2026-10-03T12:00:00Z',
    updated_at: '2026-10-03T12:10:00Z',
  }
  return {
    runs: { workflow_runs: [run] },
    workflow: { id: 42, path: '.github/workflows/staging-admission.yml' },
    proof: {
      ok: true,
      evidenceVersion: 1,
      scope: 'three-service-release',
      migrationAuthorityGranted: false,
      environment: 'staging',
      revision: SHA,
      target: STAGING_RELEASE_TARGET,
      admittedAt: '2026-10-03T12:05:00.000Z',
      topology: {
        ok: true,
        environment: 'staging',
        revision: SHA,
        services: Object.fromEntries(
          Object.keys(STAGING_RELEASE_TARGET.services).map((name) => [
            name,
            {
              revision: SHA,
              revisionSource: 'git',
              deploymentStatus: 'SUCCESS',
              instanceStatus: 'RUNNING',
            },
          ]),
        ),
      },
    },
    releaseSha: SHA,
    repository: REPOSITORY,
    now: NOW,
  }
}

test('admits one recent trusted run with three exact service revisions', () => {
  const evidence = fixture()
  assert.equal(selectTrustedRun(evidence.runs, evidence.workflow, evidence).id, 123)
  assert.deepEqual(verifyPromotionAdmissionEvidence(evidence), {
    ok: true,
    revision: SHA,
    runId: 123,
    admittedAt: evidence.proof.admittedAt,
  })
})

test('rejects a wrong SHA on each service and a wrong candidate SHA', () => {
  for (const name of Object.keys(STAGING_RELEASE_TARGET.services)) {
    const evidence = fixture()
    evidence.proof.topology.services[name].revision = OTHER_SHA
    assert.throws(() => verifyPromotionAdmissionEvidence(evidence), /service-revision-mismatch/u)
  }
  const evidence = fixture()
  evidence.releaseSha = OTHER_SHA
  assert.throws(() => verifyPromotionAdmissionEvidence(evidence), /invalid-three-service-proof/u)
})

test('rejects wrong origin, status, workflow identity, and repository', () => {
  const mutations = [
    (e) => {
      e.runs.workflow_runs[0].event = 'pull_request'
    },
    (e) => {
      e.runs.workflow_runs[0].conclusion = 'failure'
    },
    (e) => {
      e.runs.workflow_runs[0].workflow_id = 99
    },
    (e) => {
      e.runs.workflow_runs[0].path = '.github/workflows/other.yml'
    },
    (e) => {
      e.runs.workflow_runs[0].head_repository.full_name = 'other/repository'
    },
    (e) => {
      e.workflow.path = '.github/workflows/other.yml'
    },
  ]
  for (const mutate of mutations) {
    const evidence = fixture()
    mutate(evidence)
    assert.throws(() => verifyPromotionAdmissionEvidence(evidence))
  }
})

test('rejects stale or future admission and incomplete proof', () => {
  const mutations = [
    (e) => {
      e.now += 60 * 60 * 1000
    },
    (e) => {
      e.proof.admittedAt = '2026-10-03T11:00:00.000Z'
    },
    (e) => {
      e.proof.admittedAt = '2026-10-03T12:31:00.000Z'
    },
    (e) => {
      delete e.proof.topology.services['staging-workers']
    },
    (e) => {
      e.proof.scope = 'web-only'
    },
    (e) => {
      e.proof.evidenceVersion = 0
    },
  ]
  for (const mutate of mutations) {
    const evidence = fixture()
    mutate(evidence)
    assert.throws(() => verifyPromotionAdmissionEvidence(evidence))
  }
})

test('bounded JSON parser refuses malformed and oversized evidence', () => {
  assert.deepEqual(parseBoundedEvidence('{"ok":true}'), { ok: true })
  assert.throws(() => parseBoundedEvidence('{'), /invalid-evidence-json/u)
  assert.throws(
    () => parseBoundedEvidence('x'.repeat(MAX_EVIDENCE_BYTES + 1)),
    /invalid-evidence-size/u,
  )
})

test('bounded trusted log requires exactly one parseable admission proof', () => {
  const proof = JSON.stringify(fixture().proof)
  const line = `admit-staging\tWait for exact three-service staging admission\t2026-10-03T12:05:00Z\t${proof}`
  assert.deepEqual(parseTrustedAdmissionLog(`unrelated\n${line}\n`), fixture().proof)
  assert.throws(() => parseTrustedAdmissionLog('no proof'), /admission-proof-count/u)
  assert.throws(() => parseTrustedAdmissionLog(`${line}\n${line}`), /admission-proof-count/u)
  assert.throws(
    () => parseTrustedAdmissionLog(`${line.slice(0, -1)}`),
    /malformed-admission-proof/u,
  )
  assert.throws(
    () => parseTrustedAdmissionLog('x'.repeat(MAX_LOG_BYTES + 1)),
    /invalid-admission-log-size/u,
  )
})
