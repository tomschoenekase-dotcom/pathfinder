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

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical']

/** pnpm 9.15.4's JSON branch exits for any advisory before applying audit-level.
 * Validate its complete severity summary before enforcing our unchanged high gate.
 * https://github.com/pnpm/pnpm/blob/v9.15.4/lockfile/plugin-commands-audit/src/audit.ts#L234-L245
 */
export function classifyProductionAuditResult(result) {
  const refused = { ...result, code: result?.code || 1, auditReportValid: false }
  if (![0, 1].includes(result?.code) || result.signal || result.executionError) return refused
  let report
  try {
    report = JSON.parse(result.stdout)
  } catch {
    return refused
  }
  if (
    !report ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    'error' in report ||
    'errors' in report
  )
    return refused
  const counts = report.metadata?.vulnerabilities
  const advisories = report.advisories
  if (
    !counts ||
    typeof counts !== 'object' ||
    Array.isArray(counts) ||
    Object.keys(counts).sort().join(',') !== [...SEVERITIES].sort().join(',') ||
    !SEVERITIES.every(
      (severity) => Number.isSafeInteger(counts[severity]) && counts[severity] >= 0,
    ) ||
    !advisories ||
    typeof advisories !== 'object' ||
    Array.isArray(advisories)
  )
    return refused
  const observed = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]))
  for (const advisory of Object.values(advisories)) {
    if (
      !advisory ||
      typeof advisory !== 'object' ||
      Array.isArray(advisory) ||
      !SEVERITIES.includes(advisory.severity) ||
      typeof advisory.module_name !== 'string' ||
      !advisory.module_name.trim()
    )
      return refused
    observed[advisory.severity] += 1
  }
  if (!SEVERITIES.every((severity) => observed[severity] === counts[severity])) return refused
  return {
    ...result,
    code: counts.high + counts.critical > 0 ? 1 : 0,
    auditReportValid: true,
    auditSeverities: counts,
  }
}

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
    const classified = classifyProductionAuditResult(result)
    if (
      classified.auditReportValid ||
      result.code === 0 ||
      !isTransientRegistryFailure(result) ||
      attempt === delaysMs.length
    ) {
      return { ...classified, attempts: attempt + 1 }
    }
    await sleep(delaysMs[attempt])
  }

  throw new Error('unreachable-audit-state')
}
