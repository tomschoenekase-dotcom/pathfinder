// Read-only GitHub lookup. Any missing, stale or uncertain proof falls back to normal CI.
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { validateTreeEvidence } from './lib/ci-tree-evidence.mjs'
import { readTreeArtifact } from './lib/ci-tree-artifact.mjs'

const deadline = Date.now() + 45_000
const api = (path) => {
  if (Date.now() >= deadline) throw new Error('lookup-deadline')
  return JSON.parse(
    execFileSync('gh', ['api', path], {
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 4_000_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
}
let proof = null
try {
  // Explicit manual runs and merge queues keep their full independent checks.
  if (!['push', 'pull_request'].includes(process.env.GITHUB_EVENT_NAME))
    throw new Error('full-run-event')
  const repository = process.env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? '')) throw new Error('repository')
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
  const workflow = api(`repos/${repository}/actions/workflows/ci.yml`)
  const runs = api(
    `repos/${repository}/actions/workflows/ci.yml/runs?status=success&per_page=20`,
  ).workflow_runs
  for (const run of runs) {
    if (String(run.id) === process.env.GITHUB_RUN_ID || run.path !== '.github/workflows/ci.yml')
      continue
    if (
      run.head_repository?.full_name !== repository ||
      !['push', 'workflow_dispatch', 'merge_group'].includes(run.event)
    )
      continue
    if (Date.now() - Date.parse(run.updated_at) > 6 * 60 * 60 * 1000) continue
    const artifacts = api(`repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`)
    if (artifacts.total_count > 100) continue
    const matching = artifacts.artifacts.filter(
      (a) => a.name === `ci-full-tree-${tree}-attempt-${run.run_attempt}` && a.expired === false,
    )
    if (matching.length !== 1) continue
    const artifact = matching[0]
    if (artifact.size_in_bytes > 256_000) continue
    // Parse bounded ZIP bytes in memory. Never execute or unpack artifact paths.
    const zip = execFileSync(
      'gh',
      ['api', `repos/${repository}/actions/artifacts/${artifact.id}/zip`],
      { timeout: 5_000, maxBuffer: 256_000, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const evidence = readTreeArtifact(zip)
    const commit = api(`repos/${repository}/git/commits/${run.head_sha}`)
    if (commit.tree.sha !== tree) continue
    const jobsResponse = api(
      `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
    )
    if (jobsResponse.total_count !== jobsResponse.jobs.length) continue
    if (
      !validateTreeEvidence({
        evidence,
        run,
        jobs: jobsResponse.jobs,
        artifact,
        repository,
        tree,
        workflowId: workflow.id,
      })
    )
      continue
    proof = { tree, runId: run.id, recordedAt: evidence.recordedAt }
    break
  }
} catch {
  proof = null
}
const outputs = proof
  ? {
      verified: 'true',
      mode: 'verified-tree',
      reuse_verified: 'true',
      evidence_tree: proof.tree,
      evidence_run_id: String(proof.runId),
      evidence_recorded_at: proof.recordedAt,
      run_visitor_launch: 'false',
      run_database_integration: 'false',
      run_browser_gates: 'false',
      run_workspace_graph: 'false',
      turbo_filters: '',
    }
  : { verified: 'false' }
appendFileSync(
  process.env.GITHUB_OUTPUT,
  Object.entries(outputs)
    .map(([k, v]) => `${k}=${v}\n`)
    .join(''),
)
process.stdout.write(
  proof
    ? `Identical source tree qualified by full CI run ${proof.runId}; fresh policy and promotion gates remain required.\n`
    : 'No admissible identical-tree proof; normal CI remains required.\n',
)
