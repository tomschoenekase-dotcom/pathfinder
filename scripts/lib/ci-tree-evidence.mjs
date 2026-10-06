const SHA = /^[0-9a-f]{40}$/u
export const MAX_EVIDENCE_AGE_MS = 6 * 60 * 60 * 1000
export const FULL_JOB_NAMES = [
  'plan',
  'railway-iac',
  'visitor-launch',
  'policy-and-integration',
  'browser-gates (1/3)',
  'browser-gates (2/3)',
  'browser-gates (3/3)',
  'workspace-checks (types-and-lint)',
  'workspace-checks (tests)',
  'ci',
  'ci-required',
]

export function validateTreeEvidence({
  evidence,
  run,
  jobs,
  artifact,
  repository,
  tree,
  workflowId,
  now = Date.now(),
}) {
  if (!SHA.test(tree ?? '') || evidence?.schemaVersion !== 1 || evidence.mode !== 'full')
    return false
  if (
    evidence.repository !== repository ||
    evidence.tree !== tree ||
    !SHA.test(evidence.revision ?? '')
  )
    return false
  if (
    run?.status !== 'completed' ||
    run.conclusion !== 'success' ||
    run.path !== '.github/workflows/ci.yml'
  )
    return false
  if (!['push', 'pull_request', 'merge_group', 'workflow_dispatch'].includes(run.event))
    return false
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository)
    return false
  if (
    run.workflow_id !== workflowId ||
    run.head_sha !== evidence.revision ||
    run.id !== evidence.runId ||
    run.run_attempt !== evidence.attempt
  )
    return false
  if (
    artifact?.expired !== false ||
    artifact.name !== `ci-full-tree-${tree}-attempt-${run.run_attempt}` ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > 256_000
  )
    return false
  if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== run.head_sha)
    return false
  const recorded = Date.parse(evidence.recordedAt)
  const created = Date.parse(artifact.created_at)
  if (
    !Number.isFinite(recorded) ||
    !Number.isFinite(created) ||
    now < recorded ||
    now - recorded > MAX_EVIDENCE_AGE_MS
  )
    return false
  if (Math.abs(created - recorded) > 5 * 60 * 1000) return false
  if (!Array.isArray(jobs) || jobs.length !== FULL_JOB_NAMES.length) return false
  return FULL_JOB_NAMES.every(
    (name) =>
      jobs.filter((job) => job.name === name).length === 1 &&
      jobs.find((job) => job.name === name).status === 'completed' &&
      jobs.find((job) => job.name === name).conclusion === 'success',
  )
}

export function validPlanTreeProof(outputs, expectedTree, now = Date.now()) {
  if (
    outputs?.mode !== 'verified-tree' ||
    outputs.reuse_verified !== 'true' ||
    !SHA.test(expectedTree ?? '')
  )
    return false
  if (
    outputs.evidence_tree !== expectedTree ||
    !/^[1-9][0-9]*$/u.test(outputs.evidence_run_id ?? '')
  )
    return false
  const recorded = Date.parse(outputs.evidence_recorded_at)
  return Number.isFinite(recorded) && now >= recorded && now - recorded <= MAX_EVIDENCE_AGE_MS
}
