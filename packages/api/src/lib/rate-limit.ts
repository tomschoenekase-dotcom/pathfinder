import IORedis from 'ioredis'

import { env, logger } from '@pathfinder/config'

let redis: IORedis | null = null
let warnedMissingRedisUrl = false

// ---------------------------------------------------------------------------
// In-memory fallback limiter
//
// Used when Redis is unavailable (REDIS_URL unset, or a Redis command fails).
// It is a per-process fixed-window counter — NOT shared across instances — so it
// cannot enforce a precise global limit in a multi-instance deployment. It exists
// so that a missing or broken Redis does not leave the public AI chat endpoint
// completely unprotected (every Claude call costs money). Redis remains the
// source of truth whenever it is reachable.
// ---------------------------------------------------------------------------

type MemoryBucket = { count: number; resetAt: number }

const memoryBuckets = new Map<string, MemoryBucket>()
const MEMORY_BUCKET_SWEEP_THRESHOLD = 10_000

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
    // Opportunistic cleanup so the map cannot grow unbounded under churn.
    if (memoryBuckets.size > MEMORY_BUCKET_SWEEP_THRESHOLD) {
      sweepExpiredBuckets(now)
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
        error: 'REDIS_URL is not configured; using in-memory per-process rate limiting',
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

// Returns true when the request is allowed. Prefers Redis; falls back to a
// per-process in-memory limiter when Redis is missing or erroring, so the
// endpoint is never left entirely unprotected.
export async function checkRateLimit(
  key: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<boolean> {
  const client = getRedisClient()

  if (!client) {
    return checkRateLimitInMemory(key, maxRequests, windowSeconds)
  }

  try {
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

    // Degrade to the in-memory limiter rather than failing fully open.
    return checkRateLimitInMemory(key, maxRequests, windowSeconds)
  }
}

export function _resetRateLimitForTesting(): void {
  redis?.disconnect()
  redis = null
  warnedMissingRedisUrl = false
  memoryBuckets.clear()
}
