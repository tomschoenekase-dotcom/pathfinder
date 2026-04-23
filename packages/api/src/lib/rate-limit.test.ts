import { beforeEach, describe, expect, it, vi } from 'vitest'

const configState = vi.hoisted(() => ({
  env: {
    REDIS_URL: 'redis://localhost:6379',
  } as { REDIS_URL?: string | undefined },
  logger: {
    warn: vi.fn(),
  },
}))

const redisMockState = vi.hoisted(() => ({
  instances: [] as Array<{
    incr: ReturnType<typeof vi.fn>
    expire: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }>,
  nextIncrResult: 1,
  nextIncrError: null as Error | null,
}))

vi.mock('@pathfinder/config', () => configState)

vi.mock('ioredis', () => ({
  default: vi.fn().mockImplementation(() => {
    const instance = {
      incr: vi.fn().mockImplementation(() => {
        if (redisMockState.nextIncrError) {
          return Promise.reject(redisMockState.nextIncrError)
        }

        return Promise.resolve(redisMockState.nextIncrResult)
      }),
      expire: vi.fn().mockResolvedValue(1),
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
    redisMockState.nextIncrResult = 1
    redisMockState.nextIncrError = null
    configState.env.REDIS_URL = 'redis://localhost:6379'
    configState.logger.warn.mockReset()
  })

  it('allows requests below the limit and sets expiry on the first hit', async () => {
    redisMockState.nextIncrResult = 1

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(true)
    const redis = redisMockState.instances[0]
    expect(redis?.incr).toHaveBeenCalledWith('ratelimit:test')
    expect(redis?.expire).toHaveBeenCalledWith('ratelimit:test', 60)
  })

  it('blocks requests over the limit', async () => {
    redisMockState.nextIncrResult = 3

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(false)
    const redis = redisMockState.instances[0]
    expect(redis?.expire).not.toHaveBeenCalled()
  })

  it('allows requests when Redis is unavailable', async () => {
    redisMockState.nextIncrError = new Error('Redis unavailable')

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(true)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rate_limit.check_failed',
      }),
    )
  })

  it('allows requests when REDIS_URL is unset', async () => {
    configState.env.REDIS_URL = undefined

    await expect(checkRateLimit('ratelimit:test', 2, 60)).resolves.toBe(true)
    expect(redisMockState.instances).toHaveLength(0)
    expect(configState.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'rate_limit.redis_url_missing',
      }),
    )
  })
})
