const TRANSIENT_REGISTRY_PATTERNS = [
  /\b(?:502|503|504)\b/u,
  /bad gateway/iu,
  /service unavailable/iu,
  /gateway timeout/iu,
  /too many requests/iu,
  /\b429\b/u,
  /\b(?:eai_again|econnreset|etimedout)\b/iu,
  /fetch failed/iu,
  /socket timeout/iu,
  /registry request timeout/iu,
]

export function isTransientRegistryFailure(result) {
  if (result?.code === 0) return false
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
  return TRANSIENT_REGISTRY_PATTERNS.some((pattern) => pattern.test(output))
}

export async function runProductionDependencyAudit({
  run,
  sleep,
  delaysMs = [5_000, 10_000, 20_000],
}) {
  if (typeof run !== 'function' || typeof sleep !== 'function' || !Array.isArray(delaysMs)) {
    throw new Error('invalid-audit-runner')
  }

  for (let attempt = 0; attempt <= delaysMs.length; attempt += 1) {
    const result = await run()
    if (result.code === 0 || !isTransientRegistryFailure(result) || attempt === delaysMs.length) {
      return { ...result, attempts: attempt + 1 }
    }
    await sleep(delaysMs[attempt])
  }

  throw new Error('unreachable-audit-state')
}

const BLOCKING_SEVERITIES = new Set(['high', 'critical'])
const KNOWN_SEVERITIES = new Set(['info', 'low', 'moderate', 'high', 'critical'])

/**
 * pnpm 9 `audit --json` exits 1 when any advisory exists and ignores `--audit-level`, so the exit
 * code alone cannot enforce the high-severity threshold. Decide from the report itself. Anything
 * that is not a complete, self-consistent report fails closed.
 */
export function evaluateProductionAudit(result) {
  let report
  try {
    report = JSON.parse(result?.stdout ?? '')
  } catch {
    return { ok: false, reason: 'unparseable-audit-report', advisories: [] }
  }
  const counts = report?.metadata?.vulnerabilities
  const advisoryMap = report?.advisories
  if (
    !report ||
    typeof report !== 'object' ||
    'error' in report ||
    !counts ||
    typeof counts !== 'object' ||
    !advisoryMap ||
    typeof advisoryMap !== 'object' ||
    Array.isArray(advisoryMap)
  ) {
    return { ok: false, reason: 'incomplete-audit-report', advisories: [] }
  }
  for (const severity of KNOWN_SEVERITIES) {
    if (!Number.isInteger(counts[severity] ?? 0) || (counts[severity] ?? 0) < 0) {
      return { ok: false, reason: 'invalid-severity-count', advisories: [] }
    }
  }
  const advisories = Object.values(advisoryMap).map((advisory) => ({
    id: advisory?.github_advisory_id ?? null,
    module: advisory?.module_name ?? null,
    severity: advisory?.severity ?? null,
    title: advisory?.title ?? null,
  }))
  if (advisories.some(({ severity }) => !KNOWN_SEVERITIES.has(severity))) {
    return { ok: false, reason: 'unknown-advisory-severity', advisories }
  }
  const total = [...KNOWN_SEVERITIES].reduce((sum, severity) => sum + (counts[severity] ?? 0), 0)
  if (Object.keys(counts).some((severity) => !KNOWN_SEVERITIES.has(severity))) {
    return { ok: false, reason: 'unknown-severity-count', advisories }
  }
  // A nonzero exit must be explained by advisories in the report; otherwise pnpm failed.
  if (result.code !== 0 && total === 0) {
    return { ok: false, reason: 'audit-command-failed', advisories }
  }
  if (advisories.length === 0 && total > 0) {
    return { ok: false, reason: 'advisory-count-mismatch', advisories }
  }
  const blocking =
    [...BLOCKING_SEVERITIES].some((severity) => (counts[severity] ?? 0) > 0) ||
    advisories.some(({ severity }) => BLOCKING_SEVERITIES.has(severity))
  if (blocking) return { ok: false, reason: 'blocking-advisories', advisories }
  return { ok: true, reason: total ? 'below-threshold-advisories' : 'clean', advisories }
}
