// Final CI gate. Passes only when every required job succeeded, or when the change plan
// legitimately skipped a job that is allowed to be skipped. Skipped is never a pass by default.

const OPTIONAL_WHEN_PLANNED_OUT = new Map([['visitor-launch', 'run_visitor_launch']])
const REQUIRED_JOBS = ['plan', 'ci', 'railway-iac', 'visitor-launch']

export function evaluateGate(needs) {
  const failures = []
  const notes = []
  if (!needs || typeof needs !== 'object') {
    return { ok: false, failures: ['needs context unavailable'], notes }
  }
  const planOutputs = needs.plan?.outputs ?? {}
  for (const job of REQUIRED_JOBS) {
    const result = needs[job]?.result
    if (result === 'success') continue
    if (
      result === 'skipped' &&
      OPTIONAL_WHEN_PLANNED_OUT.has(job) &&
      needs.plan?.result === 'success' &&
      planOutputs[OPTIONAL_WHEN_PLANNED_OUT.get(job)] === 'false' &&
      planOutputs.mode !== 'full'
    ) {
      notes.push(`${job} skipped by the change plan (${planOutputs.mode})`)
      continue
    }
    failures.push(`${job}: ${result ?? 'missing'}`)
  }
  return { ok: failures.length === 0, failures, notes }
}
