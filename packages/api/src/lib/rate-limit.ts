import IORedis from 'ioredis'

import { env, logger } from '@pathfinder/config'

let redis: IORedis | null = null
let warnedMissingRedisUrl = false
let warnedMemoryCapacity = false

// ---------------------------------------------------------------------------
// In-memory fallback limiter
//
// Used outside production when Redis is unavailable (REDIS_URL unset, or a
// Redis command fails).
// It is a per-process fixed-window counter — NOT shared across instances — so it
// cannot enforce a precise global limit in a multi-instance deployment. Production
// therefore denies requests whenever the shared Redis limit cannot be checked.
// ---------------------------------------------------------------------------

type MemoryBucket = { count: number; resetAt: number }

const memoryBuckets = new Map<string, MemoryBucket>()
const MEMORY_BUCKET_CAPACITY = 10_000

const FIXED_WINDOW_INCREMENT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`

function sweepExpiredBuckets(now: number): void {
  for (const [bucketKey, bucket] of memoryBuckets) {
    if (bucket.resetAt <= now) {
      memoryBuckets.delete(bucketKey)
    }
  }
}

function checkRateLimitInMemory(key: string, maxRequests: number, windowSeconds: number): boolean {
  const now = Date.now()
  const bucket = memoryBuckets.get(key)

  if (!bucket || bucket.resetAt <= now) {
    if (memoryBuckets.size >= MEMORY_BUCKET_CAPACITY) {
      sweepExpiredBuckets(now)
    }

    if (memoryBuckets.size >= MEMORY_BUCKET_CAPACITY) {
      if (!warnedMemoryCapacity) {
        logger.warn({
          action: 'rate_limit.memory_capacity_exceeded',
          capacity: MEMORY_BUCKET_CAPACITY,
        })
        warnedMemoryCapacity = true
      }
      return false
    }

    memoryBuckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 })
    return true
  }

  bucket.count += 1
  return bucket.count <= maxRequests
}

function getRedisClient(): IORedis | null {
  if (!env.REDIS_URL) {
    if (!warnedMissingRedisUrl) {
      logger.warn({
        action: 'rate_limit.redis_url_missing',
        deploymentEnvironment: env.RAILWAY_ENVIRONMENT,
        failClosed: env.RAILWAY_ENVIRONMENT === 'production',
        error:
          env.RAILWAY_ENVIRONMENT === 'production'
            ? 'REDIS_URL is not configured; denying production rate-limit checks'
            : 'REDIS_URL is not configured; using in-memory per-process rate limiting',
      })
      warnedMissingRedisUrl = true
    }

    return null
  }

  if (!redis) {
    redis = new IORedis(env.REDIS_URL, {
      maxRetriesPerRequest: 1,
      // Queue the first command while the new socket reaches ready. With this
      // disabled, a healthy Redis rejects the first request on every cold start.
      // maxRetriesPerRequest still bounds commands when Redis is unavailable.
      enableOfflineQueue: true,
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

// Returns true when the request is allowed. Production requires the shared
// Redis result and fails closed. Non-production environments retain a bounded
// per-process fallback so local, preview, and staging work can continue.
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const client = getRedisClient()

    if (!client) {
      if (env.RAILWAY_ENVIRONMENT === 'production') {
        return false
      }

      return checkRateLimitInMemory(key, maxRequests, windowSeconds)
    }

    // INCR plus TTL repair runs atomically. The TTL branch also repairs keys
    // left without expiry by deployments that used the former two-command path.
    const rawCount = await client.eval(FIXED_WINDOW_INCREMENT_SCRIPT, 1, key, windowSeconds)
    const count = typeof rawCount === 'number' ? rawCount : Number(rawCount)

    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error('Redis returned an invalid rate-limit count')
    }

    return count <= maxRequests
  } catch (error) {
    logger.warn({
      action: 'rate_limit.check_failed',
      deploymentEnvironment: env.RAILWAY_ENVIRONMENT,
      failClosed: env.RAILWAY_ENVIRONMENT === 'production',
      error: error instanceof Error ? error.message : 'Unknown Redis error',
    })

    if (env.RAILWAY_ENVIRONMENT === 'production') {
      return false
    }

    return checkRateLimitInMemory(key, maxRequests, windowSeconds)
  }
}

export function _resetRateLimitForTesting(): void {
  redis?.disconnect()
  redis = null
  warnedMissingRedisUrl = false
  warnedMemoryCapacity = false
  memoryBuckets.clear()
}
