import IORedis from 'ioredis'

import { env } from '@pathfinder/config'

let sharedConnection: IORedis | null = null
const HEALTH_CLEANUP_MARGIN_MS = 50
const MAX_HEALTH_TIMEOUT_MS = 2_147_483_647
const MIN_HEALTH_TIMEOUT_MS = 2
const HEALTH_DEADLINE = Symbol('health-deadline')

function createHealthConnection(timeoutMs: number): IORedis {
  return new IORedis(env.REDIS_URL!, {
    commandTimeout: timeoutMs,
    connectTimeout: timeoutMs,
    enableOfflineQueue: false,
    enableReadyCheck: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
}

export async function checkBullMQConnection(timeoutMs: number): Promise<unknown> {
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_HEALTH_TIMEOUT_MS ||
    timeoutMs > MAX_HEALTH_TIMEOUT_MS
  ) {
    throw new Error('Health-check timeout must be a supported integer')
  }
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured')
  }

  const margin = Math.min(HEALTH_CLEANUP_MARGIN_MS, Math.max(1, Math.floor(timeoutMs / 20)))
  const operationTimeoutMs = timeoutMs - margin
  const connection = createHealthConnection(operationTimeoutMs)
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

export function getBullMQConnection(): IORedis {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured')
  }

  if (!sharedConnection) {
    sharedConnection = new IORedis(env.REDIS_URL, {
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    })
  }

  return sharedConnection
}

export async function closeBullMQConnection(): Promise<void> {
  if (!sharedConnection) {
    return
  }

  const connection = sharedConnection
  sharedConnection = null
  await connection.quit()
}
