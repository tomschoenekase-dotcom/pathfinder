import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ExecutionLeaseCancelledError,
  ExecutionLeaseOwnershipLostError,
  withExecutionLeaseHeartbeat,
} from './execution-lease-heartbeat'

describe('withExecutionLeaseHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('aborts provider work when a concurrent takeover rejects renewal', async () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    let providerSignal: AbortSignal | undefined
    const execution = withExecutionLeaseHeartbeat({
      intervalMs: 1_000,
      renew,
      operation: (signal) => {
        providerSignal = signal
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    })
    const rejection = expect(execution).rejects.toBeInstanceOf(ExecutionLeaseOwnershipLostError)

    await vi.advanceTimersByTimeAsync(1_000)

    await rejection
    expect(providerSignal?.aborted).toBe(true)
    expect(renew).toHaveBeenCalledTimes(2)
  })

  it('checks ownership again before returning a provider result', async () => {
    const renew = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    await expect(
      withExecutionLeaseHeartbeat({
        intervalMs: 60_000,
        renew,
        operation: async () => 'provider-result',
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseOwnershipLostError)
  })

  it('renews repeatedly and clears its timer after successful provider work', async () => {
    vi.useFakeTimers()
    const renew = vi.fn().mockResolvedValue(true)
    let finish: ((value: string) => void) | undefined
    const execution = withExecutionLeaseHeartbeat({
      intervalMs: 1_000,
      renew,
      operation: () =>
        new Promise<string>((resolve) => {
          finish = resolve
        }),
    })

    await vi.advanceTimersByTimeAsync(3_000)
    finish?.('done')
    await expect(execution).resolves.toBe('done')
    expect(renew).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(renew).toHaveBeenCalledTimes(5)
  })

  it('preserves a user-cancellation classification separately from ownership loss', async () => {
    await expect(
      withExecutionLeaseHeartbeat({
        intervalMs: 60_000,
        renew: vi.fn().mockResolvedValue(false),
        leaseLostError: () => new ExecutionLeaseCancelledError(),
        operation: async () => 'unreachable',
      }),
    ).rejects.toBeInstanceOf(ExecutionLeaseCancelledError)
  })
})
