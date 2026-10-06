// Final CI gate. Passes only when every required job succeeded, or when the change plan
// legitimately skipped a job that is allowed to be skipped. Skipped is never a pass by default.
import { validPlanTreeProof } from './ci-tree-evidence.mjs'

const OPTIONAL_WHEN_PLANNED_OUT = new Map([
  ['visitor-launch', 'run_visitor_launch'],
  ['browser-gates', 'run_browser_gates'],
  ['workspace-checks', 'run_workspace_graph'],
])
const CORE_JOBS = ['plan', 'policy-and-integration', 'browser-gates', 'workspace-checks']
const REQUIRED_JOBS = [
  'plan',
  'ci',
  'railway-iac',
  'visitor-launch',
  'policy-and-integration',
  'browser-gates',
  'workspace-checks',
]

export function evaluateGate(needs, options) {
  return evaluateRequired(needs, REQUIRED_JOBS, options)
}
export function evaluateCoreGate(needs, options) {
  return evaluateRequired(needs, CORE_JOBS, options)
}

function evaluateRequired(needs, requiredJobs, { expectedTree, now } = {}) {
  const failures = []
  const notes = []
  if (!needs || typeof needs !== 'object') {
    return { ok: false, failures: ['needs context unavailable'], notes }
  }
  const planOutputs = needs.plan?.outputs ?? {}
  const verifiedTree = validPlanTreeProof(planOutputs, expectedTree, now)
  if (planOutputs.mode === 'verified-tree' && !verifiedTree)
    failures.push('identical-tree evidence is missing, stale or bound to another checkout')
  for (const job of requiredJobs) {
    const result = needs[job]?.result
    if (result === 'success') continue
    if (
      result === 'skipped' &&
      OPTIONAL_WHEN_PLANNED_OUT.has(job) &&
      needs.plan?.result === 'success' &&
      planOutputs[OPTIONAL_WHEN_PLANNED_OUT.get(job)] === 'false' &&
      (['scoped', 'docs-only'].includes(planOutputs.mode) || verifiedTree)
    ) {
      notes.push(`${job} skipped by the change plan (${planOutputs.mode})`)
      continue
    }
    failures.push(`${job}: ${result ?? 'missing'}`)
  }
  return { ok: failures.length === 0, failures, notes }
}
