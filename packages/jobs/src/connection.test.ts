import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const redisMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  constructor: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  ping: vi.fn(),
}))

vi.mock('ioredis', () => ({
  default: class MockIORedis {
    connect = redisMocks.connect
    disconnect = redisMocks.disconnect
    on = redisMocks.on
    ping = redisMocks.ping

    constructor(...args: unknown[]) {
      redisMocks.constructor(...args)
    }
  },
}))

vi.mock('@pathfinder/config', () => ({
  env: {
    REDIS_URL: 'redis://example.invalid:6379',
  },
}))

import { checkBullMQConnection } from './connection'

beforeEach(() => {
  for (const mock of Object.values(redisMocks)) mock.mockReset()
  redisMocks.connect.mockResolvedValue(undefined)
  redisMocks.ping.mockResolvedValue('PONG')
  redisMocks.on.mockReturnThis()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('BullMQ health probe', () => {
  it('uses an isolated bounded connection and disconnects after success', async () => {
    await expect(checkBullMQConnection(2_000)).resolves.toBe('PONG')

    expect(redisMocks.constructor).toHaveBeenCalledWith(
      'redis://example.invalid:6379',
      expect.objectContaining({
        commandTimeout: 1_950,
        connectTimeout: 1_950,
        enableOfflineQueue: false,
        enableReadyCheck: false,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
      }),
    )
    const options = redisMocks.constructor.mock.calls[0]?.[1] as {
      retryStrategy?: () => unknown
    }
    expect(options.retryStrategy?.()).toBeNull()
    expect(redisMocks.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(redisMocks.connect.mock.invocationCallOrder[0]).toBeLessThan(
      redisMocks.ping.mock.invocationCallOrder[0]!,
    )
    expect(redisMocks.disconnect).toHaveBeenCalledOnce()
  })

  it.each(['connect', 'ping'] as const)('disconnects when %s fails', async (operation) => {
    redisMocks[operation].mockRejectedValue(new Error(`${operation} failed`))

    await expect(checkBullMQConnection(2_000)).rejects.toThrow(`${operation} failed`)
    expect(redisMocks.disconnect).toHaveBeenCalledOnce()
  })

  it('disconnects before the outer deadline when acquisition is slow and ping stalls', async () => {
    vi.useFakeTimers()
    redisMocks.connect.mockImplementation(
      () => new Promise((resolve) => setTimeout(resolve, 1_000)),
    )
    redisMocks.ping.mockImplementation(() => new Promise(() => undefined))

    const probe = checkBullMQConnection(2_000)
    const rejection = expect(probe).rejects.toBeDefined()
    await vi.advanceTimersByTimeAsync(1_949)
    expect(redisMocks.disconnect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(redisMocks.ping).toHaveBeenCalledOnce()
    expect(redisMocks.disconnect).toHaveBeenCalledOnce()
  })

  it.each([0, -1, 1, 1.5, Number.NaN, 2_147_483_648])(
    'rejects an invalid timeout before creating a connection: %s',
    async (timeoutMs) => {
      await expect(checkBullMQConnection(timeoutMs)).rejects.toThrow(/supported integer/)
      expect(redisMocks.constructor).not.toHaveBeenCalled()
    },
  )
})
