import { beforeEach, describe, expect, it, vi } from 'vitest'

const configState = vi.hoisted(() => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
    RAILWAY_ENVIRONMENT: 'staging',
  } as {
    REDIS_URL?: string | undefined
    RAILWAY_ENVIRONMENT: 'production' | 'staging' | 'preview'
  },
  logger: {
    warn: vi.fn(),
  },
}))

const redisMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    eval: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }>,
  nextEvalResult: 1 as unknown,
  nextEvalError: null as Error | null,
  nextConstructorError: null as Error | null,
}))

vi.mock('@pathfinder/config', () => configState)

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => {
    if (redisMockState.nextConstructorError) {
      throw redisMockState.nextConstructorError
    }

    const instance = {
      eval: vi.fn().mockImplementation(() => {
        if (redisMockState.nextEvalError) {
          return Promise.reject(redisMockState.nextEvalError)
        }

        return Promise.resolve(redisMockState.nextEvalResult)
      }),
      disconnect: vi.fn(),
      on: vi.fn(),
    }

    redisMockState.instances.push(instance)

    return instance
  }),
}))

import { _resetRateLimitForTesting, checkRateLimit } from './rate-limit'

describe('checkRateLimit', () => {
  beforeEach(() => {
    _resetRateLimitForTesting()
    redisMockState.instances.length = 0
    redisMockState.nextEvalResult = 1
    redisMockState.nextEvalError = null
    redisMockState.nextConstructorError = null
    configState.env.REDIS_URL = 'redis://localhost:6379'
    configState.env.RAILWAY_ENVIRONMENT = 'staging'
    configState.logger.warn.mockReset()
  })

  it('atomically increments and repairs expiry while allowing requests below the limit', async () => {
    redisMockState.nextEvalResult = 1

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(true)
    const redis = redisMockState.instances[0]
    expect(redis?.eval).toHaveBeenCalledWith(
      expect.stringMatching(/INCR[\s\S]*TTL[\s\S]*ttl < 0[\s\S]*EXPIRE/),
      1,
      'ratelimit:test',
      60,
    )
  })

  it('blocks requests over the limit', async () => {
    redisMockState.nextEvalResult = 3

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(false)
  })

  it('denies requests in production when Redis is unavailable', async () => {
    configState.env.RAILWAY_ENVIRONMENT = 'production'
    redisMockState.nextEvalError = new Error('Redis unavailable')

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(false)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rate_limit.check_failed',
        failClosed: true,
      }),
    )
  })

  it('denies production requests when Redis client construction fails', async () => {
    configState.env.RAILWAY_ENVIRONMENT = 'production'
    redisMockState.nextConstructorError = new Error('Invalid Redis URL')

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(false)
    expect(redisMockState.instances).toHaveLength(0)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rate_limit.check_failed', failClosed: true }),
    )
  })

  it('denies requests in production when REDIS_URL is unset', async () => {
    configState.env.RAILWAY_ENVIRONMENT = 'production'
    configState.env.REDIS_URL = undefined

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(false)
    expect(redisMockState.instances).toHaveLength(0)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rate_limit.redis_url_missing',
        failClosed: true,
      }),
    )
  })

  it.each(['staging', 'preview'] as const)(
    'falls back to memory in %s when REDIS_URL is unset',
    async (RAILWAY_ENVIRONMENT) => {
      configState.env.RAILWAY_ENVIRONMENT = RAILWAY_ENVIRONMENT
      configState.env.REDIS_URL = undefined

      await expect(checkRateLimit(`ratelimit:mem:${RAILWAY_ENVIRONMENT}`, 2, 60)).resolves.toBe(
        true,
      )
      await expect(checkRateLimit(`ratelimit:mem:${RAILWAY_ENVIRONMENT}`, 2, 60)).resolves.toBe(
        true,
      )
      await expect(checkRateLimit(`ratelimit:mem:${RAILWAY_ENVIRONMENT}`, 2, 60)).resolves.toBe(
        false,
      )
      expect(redisMockState.instances).toHaveLength(0)
    },
  )

  it('falls back to in-memory limiting in staging when Redis errors', async () => {
    configState.env.RAILWAY_ENVIRONMENT = 'staging'
    redisMockState.nextEvalError = new Error('Redis unavailable')

    await expect(checkRateLimit('ratelimit:err', 1, 60)).resolves.toBe(true)
    await expect(checkRateLimit('ratelimit:err', 1, 60)).resolves.toBe(false)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rate_limit.check_failed', failClosed: false }),
    )
  })

  it('falls back to memory in staging when Redis client construction fails', async () => {
    redisMockState.nextConstructorError = new Error('Invalid Redis URL')

    await expect(checkRateLimit('ratelimit:constructor', 1, 60)).resolves.toBe(true)
    await expect(checkRateLimit('ratelimit:constructor', 1, 60)).resolves.toBe(false)
    expect(redisMockState.instances).toHaveLength(0)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rate_limit.check_failed', failClosed: false }),
    )
  })

  it('denies when Redis returns an invalid counter value', async () => {
    configState.env.RAILWAY_ENVIRONMENT = 'production'
    redisMockState.nextEvalResult = 0

    await expect(checkRateLimit('ratelimit:invalid', 2, 60)).resolves.toBe(false)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rate_limit.check_failed',
        error: 'Redis returned an invalid rate-limit count',
        failClosed: true,
      }),
    )
  })

  it('bounds memory use and denies new buckets after capacity is reached', async () => {
    configState.env.REDIS_URL = undefined

    for (let index = 0; index < 10_000; index += 1) {
      await expect(checkRateLimit(`ratelimit:capacity:${index}`, 1, 60)).resolves.toBe(true)
    }

    await expect(checkRateLimit('ratelimit:capacity:overflow', 1, 60)).resolves.toBe(false)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rate_limit.memory_capacity_exceeded', capacity: 10_000 }),
    )
  })

  it('warns once when a non-production REDIS_URL is unset', async () => {
    configState.env.REDIS_URL = undefined

    await checkRateLimit('ratelimit:warning:1', 2, 60)
    await checkRateLimit('ratelimit:warning:2', 2, 60)
    expect(configState.logger.warn).toHaveBeenCalledTimes(1)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'rate_limit.redis_url_missing', failClosed: false }),
    )
  })
})
