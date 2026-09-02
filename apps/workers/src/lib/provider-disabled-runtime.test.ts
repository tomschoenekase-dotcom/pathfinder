import { describe, expect, it, vi } from 'vitest'

import { startProviderDisabledRuntime } from './provider-disabled-runtime'

describe('provider-disabled worker runtime', () => {
  it('checks Redis and exposes no consumers or queues', async () => {
    vi.useFakeTimers()
    const checkConnection = vi.fn(async () => 'PONG')
    const closeConnection = vi.fn(async () => undefined)
    const runtime = await startProviderDisabledRuntime({
      checkConnection,
      closeConnection,
      onConnectionError: vi.fn(),
    })

    expect(checkConnection).toHaveBeenCalledOnce()
    expect(runtime).toMatchObject({ mode: 'provider-disabled', queues: [] })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkConnection).toHaveBeenCalledTimes(2)
    await runtime.shutdown()
    expect(closeConnection).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkConnection).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('serializes heartbeat checks and drains the active check before closing', async () => {
    vi.useFakeTimers()
    let resolveCheck: ((value: unknown) => void) | undefined
    const checkConnection = vi
      .fn()
      .mockResolvedValueOnce('PONG')
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveCheck = resolve
        }),
      )
    const closeConnection = vi.fn(async () => undefined)
    const runtime = await startProviderDisabledRuntime({
      checkConnection,
      closeConnection,
      onConnectionError: vi.fn(),
    })

    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkConnection).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkConnection).toHaveBeenCalledTimes(2)

    const shutdown = runtime.shutdown()
    await Promise.resolve()
    expect(closeConnection).not.toHaveBeenCalled()

    resolveCheck?.('PONG')
    await shutdown
    expect(closeConnection).toHaveBeenCalledOnce()
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    expect(closeConnection).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(30_000)
    expect(checkConnection).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('contains failures thrown by the heartbeat diagnostic callback', async () => {
    vi.useFakeTimers()
    const runtime = await startProviderDisabledRuntime({
      checkConnection: vi
        .fn()
        .mockResolvedValueOnce('PONG')
        .mockRejectedValueOnce(new Error('redis unavailable')),
      closeConnection: vi.fn(async () => undefined),
      onConnectionError: vi.fn(() => {
        throw new Error('diagnostic unavailable')
      }),
    })

    await vi.advanceTimersByTimeAsync(30_000)
    await expect(runtime.shutdown()).resolves.toBeUndefined()
    vi.useRealTimers()
  })

  it('closes Redis and preserves a connectivity failure', async () => {
    const failure = new Error('redis unavailable')
    const closeConnection = vi.fn(async () => undefined)
    await expect(
      startProviderDisabledRuntime({
        checkConnection: vi.fn(async () => Promise.reject(failure)),
        closeConnection,
        onConnectionError: vi.fn(),
      }),
    ).rejects.toBe(failure)
    expect(closeConnection).toHaveBeenCalledOnce()
  })

  it('preserves both the connectivity and cleanup failures', async () => {
    const connectivityFailure = new Error('redis unavailable')
    const cleanupFailure = new Error('cleanup failed')
    const result = startProviderDisabledRuntime({
      checkConnection: vi.fn(async () => Promise.reject(connectivityFailure)),
      closeConnection: vi.fn(async () => Promise.reject(cleanupFailure)),
      onConnectionError: vi.fn(),
    })

    await expect(result).rejects.toMatchObject({
      errors: [connectivityFailure, cleanupFailure],
    })
  })
})
