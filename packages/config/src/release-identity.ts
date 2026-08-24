type EnvironmentLike = Readonly<Record<string, string | undefined>>

const FULL_GIT_SHA = /^[a-f0-9]{40}$/u

function configuredValue(environment: EnvironmentLike, key: string): string | null {
  const value = environment[key]?.trim().toLowerCase()
  return value ? value : null
}

/**
 * Resolve one exact immutable application revision for public admission and worker evidence.
 * Provider metadata remains authoritative. PATHFINDER_RELEASE_SHA is accepted only as the
 * reviewed local-upload fallback, and any present invalid or conflicting identity fails closed.
 */
export function resolveReleaseRevision(environment: EnvironmentLike): string {
  const providerValues = [
    configuredValue(environment, 'RAILWAY_GIT_COMMIT_SHA'),
    configuredValue(environment, 'VERCEL_GIT_COMMIT_SHA'),
    configuredValue(environment, 'GIT_COMMIT_SHA'),
  ].filter((value): value is string => value !== null)
  const configuredRelease = configuredValue(environment, 'PATHFINDER_RELEASE_SHA')
  const observed = [...providerValues, ...(configuredRelease ? [configuredRelease] : [])]

  if (observed.length === 0 || observed.some((value) => !FULL_GIT_SHA.test(value))) {
    return 'unknown'
  }

  const distinctProviderValues = new Set(providerValues)
  if (distinctProviderValues.size > 1) return 'unknown'

  const providerRelease = providerValues[0]
  if (providerRelease && configuredRelease && providerRelease !== configuredRelease) {
    return 'unknown'
  }

  return providerRelease ?? configuredRelease ?? 'unknown'
}
