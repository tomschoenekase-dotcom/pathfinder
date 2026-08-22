import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useNetworkStatus } from './useNetworkStatus'

function setNavigatorOnline(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value })
}

describe('useNetworkStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('React', React)
    setNavigatorOnline(true)
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('reports offline, briefly confirms reconnection, then settles online', () => {
    const { result } = renderHook(() => useNetworkStatus())
    expect(result.current).toBe('online')

    act(() => window.dispatchEvent(new Event('offline')))
    expect(result.current).toBe('offline')

    act(() => window.dispatchEvent(new Event('online')))
    expect(result.current).toBe('reconnected')

    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current).toBe('online')
  })

  it('honors an initially offline browser', () => {
    setNavigatorOnline(false)
    const { result } = renderHook(() => useNetworkStatus())
    expect(result.current).toBe('offline')
  })
})
