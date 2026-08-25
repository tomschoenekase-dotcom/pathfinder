import { createHash } from 'node:crypto'
import path from 'node:path'

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function assert(condition, message) {
  if (!condition) throw new Error(`release-evidence-payload:${message}`)
}

function deterministicUuid(seed) {
  const bytes = Buffer.from(sha256(seed).slice(0, 32), 'hex')
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function repositoryReference(repositoryRoot, absolute) {
  const reference = path.relative(repositoryRoot, absolute).replaceAll('\\', '/')
  assert(reference && !reference.startsWith('../') && !path.isAbsolute(reference), 'artifact-outside-repository')
  return reference
}

export function prepareReleaseEvidencePayload({
  assessment,
  assessmentBytes,
  assessmentPath,
  handoff = null,
  handoffBytes = null,
  handoffPath = null,
  repositoryRoot,
  sourceReference,
}) {
  assert(assessment?.schemaVersion === 1, 'unsupported-assessment-schema')
  assert(/^[a-f0-9]{40}$/u.test(assessment.revision ?? ''), 'invalid-assessment-revision')
  assert(Array.isArray(assessment.gates) && assessment.gates.length > 0, 'missing-assessment-gates')

  const assessmentReference = repositoryReference(repositoryRoot, assessmentPath)
  const assessmentSha256 = sha256(assessmentBytes)
  let projectedHandoff = null
  let handoffReference = null
  let handoffSha256 = null

  if (handoff !== null) {
    assert(handoffBytes && handoffPath, 'incomplete-handoff-input')
    assert(handoff.schemaVersion === 1 && handoff.kind === 'torchiko-staging-handoff', 'unsupported-handoff-schema')
    assert(handoff.candidate?.revision === assessment.revision, 'candidate-revision-mismatch')
    assert(handoff.candidate?.clean === assessment.repository?.clean, 'candidate-cleanliness-mismatch')
    assert(handoff.releaseVerification?.sha256 === assessmentSha256, 'assessment-digest-mismatch')
    assert(handoff.releaseVerification?.readiness === assessment.readiness, 'assessment-readiness-mismatch')
    assert(handoff.releaseVerification?.passed === assessment.summary?.passed, 'assessment-pass-count-mismatch')
    assert(handoff.releaseVerification?.failed === assessment.summary?.failed, 'assessment-fail-count-mismatch')
    assert(handoff.releaseVerification?.blocked === assessment.summary?.blocked, 'assessment-blocked-count-mismatch')
    handoffReference = repositoryReference(repositoryRoot, handoffPath)
    handoffSha256 = sha256(handoffBytes)
    projectedHandoff = {
      artifactSha256: handoffSha256,
      status: handoff.admission.status,
      baseRevision: handoff.base.revision,
      baseIsAncestor: handoff.lineage.baseIsAncestor,
      ahead: handoff.lineage.ahead,
      behind: handoff.lineage.behind,
      changedFiles: handoff.delta.changedFiles,
      patchSha256: handoff.delta.patchSha256,
      migrationCount: handoff.database.count,
      latestMigration: handoff.database.latest,
      migrationChainSha256: handoff.database.chainSha256,
      requiredActions: handoff.admission.requiredActions,
      retainedGates: handoff.admission.retainedGates,
    }
  }

  const reference =
    sourceReference ??
    (handoffReference
      ? `${assessmentReference} + ${handoffReference}`
      : assessmentReference)
  assert(reference.length <= 500, 'source-reference-too-long')

  return {
    operationId: deterministicUuid(`${assessmentSha256}:${handoffSha256 ?? 'no-handoff'}:${reference}`),
    assessment,
    stagingHandoff: projectedHandoff,
    sourceReference: reference,
  }
}

