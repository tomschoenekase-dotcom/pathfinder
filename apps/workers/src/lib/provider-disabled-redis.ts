import IORedis from 'ioredis'

const HEALTH_CLEANUP_MARGIN_MS = 50
const MAX_HEALTH_TIMEOUT_MS = 2_147_483_647
const MIN_HEALTH_TIMEOUT_MS = 2
const HEALTH_DEADLINE = Symbol('provider-disabled-redis-health-deadline')

export async function checkProviderDisabledRedis(
  redisUrl: string,
  timeoutMs: number,
): Promise<unknown> {
  if (!redisUrl) throw new Error('REDIS_URL is required for provider-disabled workers')
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_HEALTH_TIMEOUT_MS ||
    timeoutMs > MAX_HEALTH_TIMEOUT_MS
  ) {
    throw new Error('Redis health timeout must be a supported integer')
  }

  const margin = Math.min(HEALTH_CLEANUP_MARGIN_MS, Math.max(1, Math.floor(timeoutMs / 20)))
  const operationTimeoutMs = timeoutMs - margin
  const connection = new IORedis(redisUrl, {
    commandTimeout: operationTimeoutMs,
    connectTimeout: operationTimeoutMs,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  connection.on('error', () => undefined)
  let deadline: ReturnType<typeof setTimeout> | undefined

  try {
    const operation = (async () => {
      await connection.connect()
      return connection.ping()
    })()
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(HEALTH_DEADLINE), operationTimeoutMs)
        deadline.unref?.()
      }),
    ])
  } finally {
    if (deadline) clearTimeout(deadline)
    connection.disconnect()
  }
}
