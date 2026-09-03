import { afterEach, describe, expect, it, vi } from 'vitest'

import { BoundedClientRequestError, runBoundedClientRequest } from './bounded-client-request'

describe('runBoundedClientRequest', () => {
  afterEach(() => vi.useRealTimers())

  it('returns a completed request and passes an active child signal', async () => {
    const parent = new AbortController()
    await expect(
      runBoundedClientRequest({
        parentSignal: parent.signal,
        timeoutMs: 1_000,
        request: async (signal) => {
          expect(signal.aborted).toBe(false)
          return 'ready'
        },
      }),
    ).resolves.toBe('ready')
  })

  it('aborts and rejects a stalled request at its deadline', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const result = runBoundedClientRequest({
      parentSignal: parent.signal,
      timeoutMs: 15_000,
      request: (signal) => {
        requestSignal = signal
        return new Promise<string>(() => undefined)
      },
    })
    const rejection = expect(result).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    await vi.advanceTimersByTimeAsync(15_000)
    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('rejects lifecycle cancellation even when transport ignores abort', async () => {
    const parent = new AbortController()
    let requestSignal: AbortSignal | undefined
    const result = runBoundedClientRequest({
      parentSignal: parent.signal,
      timeoutMs: 15_000,
      request: (signal) => {
        requestSignal = signal
        return new Promise<string>(() => undefined)
      },
    })
    const rejection = expect(result).rejects.toMatchObject({ code: 'CANCELLED' })
    await Promise.resolve()
    parent.abort()
    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('does not invoke a request after prior cancellation', async () => {
    const parent = new AbortController()
    parent.abort()
    const request = vi.fn(async () => 'unused')
    await expect(
      runBoundedClientRequest({ parentSignal: parent.signal, timeoutMs: 1_000, request }),
    ).rejects.toEqual(new BoundedClientRequestError('CANCELLED'))
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects invalid deadlines before invoking a request', async () => {
    const request = vi.fn(async () => 'unused')
    await expect(
      runBoundedClientRequest({
        parentSignal: new AbortController().signal,
        timeoutMs: 0,
        request,
      }),
    ).rejects.toThrow('Request deadline must be a positive safe integer')
    expect(request).not.toHaveBeenCalled()
  })
})
