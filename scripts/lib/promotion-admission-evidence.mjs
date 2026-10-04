import { STAGING_RELEASE_TARGET } from './staging-release-admission.mjs'

const SHA = /^[a-f0-9]{40}$/u
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u
const WORKFLOW_PATH = '.github/workflows/staging-admission.yml'
const MAX_AGE_MS = 60 * 60 * 1000
export const MAX_EVIDENCE_BYTES = 1_048_576
export const MAX_LOG_BYTES = 8_388_608

export class PromotionAdmissionError extends Error {
  constructor(code) {
    super(code)
    this.code = code
  }
}

function fail(code) {
  throw new PromotionAdmissionError(code)
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function date(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail('invalid-evidence-time')
  }
  const parsed = Date.parse(value)
  const canonical = value.includes('.') ? value : value.replace(/Z$/u, '.000Z')
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== canonical)
    fail('invalid-evidence-time')
  return parsed
}

export function parseBoundedEvidence(text) {
  if (
    typeof text !== 'string' ||
    Buffer.byteLength(text, 'utf8') > MAX_EVIDENCE_BYTES ||
    text.length === 0
  ) {
    fail('invalid-evidence-size')
  }
  try {
    return JSON.parse(text)
  } catch {
    fail('invalid-evidence-json')
  }
}

export function parseTrustedAdmissionLog(text) {
  if (
    typeof text !== 'string' ||
    text.length === 0 ||
    Buffer.byteLength(text, 'utf8') > MAX_LOG_BYTES
  ) {
    fail('invalid-admission-log-size')
  }
  const proofs = []
  for (const line of text.split(/\r?\n/u)) {
    const start = line.indexOf('{"ok":true,"evidenceVersion":1,')
    if (start < 0) continue
    try {
      proofs.push(JSON.parse(line.slice(start).trim()))
    } catch {
      fail('malformed-admission-proof')
    }
  }
  if (proofs.length !== 1) fail('admission-proof-count')
  return proofs[0]
}

export function selectTrustedRun(runs, workflow, { repository, now }) {
  if (
    !REPOSITORY.test(repository) ||
    !record(runs) ||
    !Array.isArray(runs.workflow_runs) ||
    runs.workflow_runs.length !== 1 ||
    !record(workflow)
  )
    fail('invalid-workflow-readback')
  if (!Number.isSafeInteger(workflow.id) || workflow.path !== WORKFLOW_PATH) fail('wrong-workflow')
  const run = runs.workflow_runs[0]
  if (
    !record(run) ||
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    run.workflow_id !== workflow.id ||
    run.path !== WORKFLOW_PATH ||
    run.name !== 'Staging deployment admission' ||
    run.event !== 'workflow_run' ||
    run.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository
  ) {
    fail('untrusted-admission-run')
  }
  const created = date(run.created_at)
  const completed = date(run.updated_at)
  if (created > completed || completed > now || now - created > MAX_AGE_MS)
    fail('stale-admission-run')
  return run
}

export function verifyPromotionAdmissionEvidence({
  runs,
  workflow,
  proof,
  releaseSha,
  repository,
  now,
}) {
  if (!SHA.test(releaseSha ?? '')) fail('invalid-release-sha')
  const run = selectTrustedRun(runs, workflow, { repository, now })
  if (
    !record(proof) ||
    proof.ok !== true ||
    proof.evidenceVersion !== 1 ||
    proof.scope !== 'three-service-release' ||
    proof.migrationAuthorityGranted !== false ||
    proof.environment !== 'staging' ||
    proof.revision !== releaseSha ||
    proof.target?.projectId !== STAGING_RELEASE_TARGET.projectId ||
    proof.target?.environmentId !== STAGING_RELEASE_TARGET.environmentId ||
    proof.topology?.ok !== true ||
    proof.topology?.environment !== 'staging' ||
    proof.topology?.revision !== releaseSha ||
    !record(proof.topology.services)
  ) {
    fail('invalid-three-service-proof')
  }
  const admitted = date(proof.admittedAt)
  if (
    admitted < date(run.created_at) ||
    admitted > date(run.updated_at) ||
    admitted > now ||
    now - admitted > MAX_AGE_MS
  )
    fail('stale-three-service-proof')
  const expectedServices = Object.keys(STAGING_RELEASE_TARGET.services)
  if (Object.keys(proof.topology.services).sort().join(',') !== expectedServices.sort().join(',')) {
    fail('invalid-three-service-proof')
  }
  for (const name of expectedServices) {
    const service = proof.topology.services[name]
    if (
      !record(service) ||
      service.revision !== releaseSha ||
      service.revisionSource !== 'git' ||
      service.deploymentStatus !== 'SUCCESS' ||
      service.instanceStatus !== 'RUNNING'
    ) {
      fail('service-revision-mismatch')
    }
  }
  return { ok: true, revision: releaseSha, runId: run.id, admittedAt: proof.admittedAt }
}
