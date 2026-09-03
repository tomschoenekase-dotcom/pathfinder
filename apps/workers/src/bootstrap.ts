import { checkProviderDisabledRedis } from './lib/provider-disabled-redis'
import { startProviderDisabledRuntime } from './lib/provider-disabled-runtime'
import {
  resolveWorkerStartupPolicy,
  type WorkerStartupEnvironment,
} from './lib/worker-startup-policy'
import { assertStagingWorkerReleaseIdentity } from './lib/worker-release-identity'

function assertRequiredEnvironment(keys: string[]): void {
  const missing = keys.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required worker environment variables: ${missing.join(', ')}`)
  }
}

function registerShutdown(shutdown: () => Promise<void>): void {
  let shuttingDown = false
  const handleSignal = () => {
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    void shutdown().catch(() => {
      process.exitCode = 1
    })
  }
  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)
}

export async function bootstrapWorkers() {
  const stagingRevision = assertStagingWorkerReleaseIdentity(process.env)
  if (stagingRevision) {
    process.stdout.write(
      `${JSON.stringify({
        action: 'workers.release-identity.admitted',
        revision: stagingRevision,
      })}\n`,
    )
  }
  const policy = resolveWorkerStartupPolicy(process.env as WorkerStartupEnvironment)
  assertRequiredEnvironment(policy.requiredEnvironmentKeys)

  if (policy.mode === 'provider-disabled') {
    const redisUrl = process.env.REDIS_URL!
    const runtime = await startProviderDisabledRuntime({
      checkConnection: () => checkProviderDisabledRedis(redisUrl, 5_000),
      closeConnection: async () => undefined,
      onConnectionError: () =>
        process.stderr.write(
          `${JSON.stringify({ action: 'workers.runtime.error', errorCode: 'redis-unreachable' })}\n`,
        ),
    })
    process.stdout.write(
      `${JSON.stringify({
        action: 'workers.started',
        mode: runtime.mode,
        outboundProviderWorkersEnabled: false,
        queues: runtime.queues,
      })}\n`,
    )
    registerShutdown(runtime.shutdown)
    return runtime
  }

  if (policy.mode === 'crm-only') {
    const { startCrmBackgroundRuntime } = await import('./crm-background.js')
    return startCrmBackgroundRuntime()
  }

  if (policy.mode === 'intake-upload-verification-only') {
    const { startIntakeUploadVerificationRuntime } =
      await import('./intake-upload-verification-runtime.js')
    const runtime = await startIntakeUploadVerificationRuntime()
    registerShutdown(runtime.shutdown)
    return runtime
  }

  if (policy.mode === 'evaluation-only') {
    const { startEvaluationOnlyRuntime } = await import('./evaluation-only-runtime.js')
    const runtime = await startEvaluationOnlyRuntime()
    registerShutdown(runtime.shutdown)
    return runtime
  }

  if (policy.mode === 'venue-media-derivative-only') {
    const { startVenueMediaDerivativeRuntime } = await import('./venue-media-derivative-runtime.js')
    const runtime = await startVenueMediaDerivativeRuntime()
    process.stdout.write(
      `${JSON.stringify({
        action: 'workers.started',
        mode: runtime.mode,
        outboundProviderWorkersEnabled: false,
        founderAbsenceObserverEnabled: runtime.founderAbsenceObserverEnabled,
        queues: runtime.queues,
      })}\n`,
    )
    registerShutdown(runtime.shutdown)
    return runtime
  }

  if (policy.mode === 'founder-absence-observer-only') {
    const { startFounderAbsenceObserverOnlyRuntime } =
      await import('./founder-absence-observer-only-runtime.js')
    const runtime = await startFounderAbsenceObserverOnlyRuntime()
    process.stdout.write(
      `${JSON.stringify({
        action: 'workers.started',
        mode: runtime.mode,
        outboundProviderWorkersEnabled: false,
        founderAbsenceObserverEnabled: true,
        queues: runtime.queues,
      })}\n`,
    )
    registerShutdown(runtime.shutdown)
    return runtime
  }

  const { startWorkers } = await import('./index.js')
  return startWorkers()
}

if (require.main === module) {
  void bootstrapWorkers().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ action: 'workers.start.failed', errorCode: 'startup-rejected' })}\n`,
    )
    process.exitCode = 1
  })
}
