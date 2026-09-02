import { describe, expect, it, vi } from 'vitest'

import { startOperationalHeartbeat } from './operational-heartbeat'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('operational heartbeat lifecycle', () => {
  it('serializes interval writes and drains the active write before stopping', async () => {
    vi.useFakeTimers()
    const intervalWrite = deferred()
    const write = vi
      .fn<() => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(intervalWrite.promise)
    const stop = await startOperationalHeartbeat({ write, onError: vi.fn(), intervalMs: 100 })

    await vi.advanceTimersByTimeAsync(100)
    expect(write).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(2)

    const stopping = stop()
    expect(stop()).toBe(stopping)
    let stopped = false
    void stopping.then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)

    intervalWrite.resolve()
    await stopping
    await vi.advanceTimersByTimeAsync(200)
    expect(write).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('contains write and diagnostic callback failures', async () => {
    const onError = vi.fn(() => {
      throw new Error('diagnostic failure')
    })
    const stop = await startOperationalHeartbeat({
      write: vi.fn().mockRejectedValue(new Error('heartbeat failure')),
      onError,
    })

    expect(onError).toHaveBeenCalledOnce()
    await expect(stop()).resolves.toBeUndefined()
  })
})
