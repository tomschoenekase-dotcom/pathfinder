import { checkProviderDisabledRedis } from './lib/provider-disabled-redis'
import { startProviderDisabledRuntime } from './lib/provider-disabled-runtime'
import { startFounderAbsenceObserver } from './founder-absence-observer-runtime'

export async function startFounderAbsenceObserverOnlyRuntime() {
  const redisUrl = process.env.REDIS_URL!
  const connectivity = await startProviderDisabledRuntime({
    checkConnection: () => checkProviderDisabledRedis(redisUrl, 5_000),
    closeConnection: async () => undefined,
    onConnectionError: () =>
      process.stderr.write(
        `${JSON.stringify({ action: 'workers.runtime.error', errorCode: 'redis-unreachable' })}\n`,
      ),
  })
  const observer = await startFounderAbsenceObserver()
  return {
    mode: 'founder-absence-observer-only' as const,
    queues: [] as const,
    shutdown: async () => {
      await observer.shutdown()
      await connectivity.shutdown()
    },
  }
}
