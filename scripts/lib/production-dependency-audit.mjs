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
