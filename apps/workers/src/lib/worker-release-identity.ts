import { resolveReleaseRevision } from '@pathfinder/config/release-identity'

type WorkerReleaseEnvironment = Readonly<Record<string, string | undefined>>

/**
 * Staging workers have no public health endpoint, so reject ambiguous release identity before
 * opening queues or importing a worker runtime. This keeps provider-disabled modes from appearing
 * healthy when Railway metadata and the reviewed local-upload release variable disagree.
 */
export function assertStagingWorkerReleaseIdentity(
  environment: WorkerReleaseEnvironment,
): string | null {
  if (environment.RAILWAY_ENVIRONMENT !== 'staging') return null

  const revision = resolveReleaseRevision(environment)
  if (revision === 'unknown') {
    throw new Error('staging-worker-release-identity-invalid')
  }
  return revision
}
