import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  ProspectImportPollingCancelledError,
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
})
