import IORedis from 'ioredis'

import { env, logger } from '@pathfinder/config'

let redis: IORedis | null = null
let warnedMissingRedisUrl = false

function getRedisClient(): IORedis | null {
  if (!env.REDIS_URL) {
    if (!warnedMissingRedisUrl) {
      logger.warn({
        action: 'rate_limit.redis_url_missing',
        error: 'REDIS_URL is not configured; allowing requests',
      })
      warnedMissingRedisUrl = true
    }

    return null
  }

  if (!redis) {
    redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })

    redis.on('error', (error) => {
      logger.warn({
        action: 'rate_limit.redis_error',
        error: error.message,
      })
    })
  }

  return redis
}

// Returns true when the request is allowed. Redis failures fail open so guests
// are not blocked by infrastructure issues.
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const client = getRedisClient()

    if (!client) {
      return true
    }

    const count = await client.incr(key)

    if (count === 1) {
      await client.expire(key, windowSeconds)
    }

    return count <= maxRequests
  } catch (error) {
    logger.warn({
      action: 'rate_limit.check_failed',
      error: error instanceof Error ? error.message : 'Unknown Redis error',
    })

    return true
  }
}

export function _resetRateLimitForTesting(): void {
  redis?.disconnect()
  redis = null
  warnedMissingRedisUrl = false
}
