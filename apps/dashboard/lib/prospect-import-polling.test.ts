import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProspectImportPollingCancelledError,
  ProspectImportRequestDeadlineError,
  runProspectImportRequest,
  throwIfProspectImportPollingCancelled,
  waitForProspectImportPoll,
} from './prospect-import-polling'

describe('waitForProspectImportPoll', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('resolves after the bounded polling interval', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const result = waitForProspectImportPoll(controller.signal)

    await vi.advanceTimersByTimeAsync(1_999)
    let settled = false
    void result.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toBeUndefined()
  })

  it('rejects immediately when polling is already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(waitForProspectImportPoll(controller.signal)).rejects.toBeInstanceOf(
      ProspectImportPollingCancelledError,
    )
  })

  it('clears a pending timer and rejects when the page lifecycle is cancelled', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const result = waitForProspectImportPoll(controller.signal)

    controller.abort()

    await expect(result).rejects.toBeInstanceOf(ProspectImportPollingCancelledError)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects invalid intervals rather than scheduling an unbounded timer', async () => {
    await expect(waitForProspectImportPoll(new AbortController().signal, 0)).rejects.toThrow(
      'Poll delay must be a positive safe integer',
    )
  })

  it('guards state updates after an awaited request is cancelled', () => {
    const controller = new AbortController()
    controller.abort()

    expect(() => throwIfProspectImportPollingCancelled(controller.signal)).toThrow(
      ProspectImportPollingCancelledError,
    )
  })

  it('returns a completed bounded import request', async () => {
    const controller = new AbortController()

    await expect(
      runProspectImportRequest(controller.signal, async (signal) => {
        expect(signal.aborted).toBe(false)
        return 'ready'
      }),
    ).resolves.toBe('ready')
  })

  it('aborts and rejects a stalled request at the fixed deadline', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const result = runProspectImportRequest(
      controller.signal,
      (signal) => {
        requestSignal = signal
        return new Promise<string>(() => undefined)
      },
      30_000,
    )
    const rejection = expect(result).rejects.toBeInstanceOf(ProspectImportRequestDeadlineError)

    await vi.advanceTimersByTimeAsync(30_000)

    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('rejects immediately on lifecycle cancellation even if transport ignores abort', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const result = runProspectImportRequest(controller.signal, (signal) => {
      requestSignal = signal
      return new Promise<string>(() => undefined)
    })
    const rejection = expect(result).rejects.toBeInstanceOf(ProspectImportPollingCancelledError)

    await Promise.resolve()
    controller.abort()

    await rejection
    expect(requestSignal?.aborted).toBe(true)
  })

  it('rejects invalid request deadlines before invoking transport', async () => {
    const request = vi.fn(async () => 'unused')

    await expect(
      runProspectImportRequest(new AbortController().signal, request, 0),
    ).rejects.toThrow('Request deadline must be a positive safe integer')
    expect(request).not.toHaveBeenCalled()
  })
})
