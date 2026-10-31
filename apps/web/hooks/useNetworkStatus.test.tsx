import React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
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

  it.each([true, false])(
    'hydrates Node 24 server markup without navigator.onLine into an online=%s browser',
    async (online) => {
      function Probe() {
        const state = useNetworkStatus()
        return <output>{state}</output>
      }
      const browserNavigator = window.navigator
      // Node 24 exposes navigator but has no onLine property.
      vi.stubGlobal('navigator', {})
      const html = renderToString(<Probe />)
      expect(html).toBe('<output>online</output>')
      vi.stubGlobal('navigator', browserNavigator)
      setNavigatorOnline(online)
      const container = document.createElement('div')
      container.innerHTML = html
      document.body.append(container)
      const onRecoverableError = vi.fn()
      let root: ReturnType<typeof hydrateRoot> | undefined
      try {
        await act(async () => {
          root = hydrateRoot(container, <Probe />, { onRecoverableError })
        })
        expect(onRecoverableError).not.toHaveBeenCalled()
        expect(container.textContent).toBe(online ? 'online' : 'offline')
      } finally {
        act(() => root?.unmount())
        container.remove()
      }
    },
  )

  it('renders the same server state when navigator is absent or reports offline', () => {
    function Probe() {
      return <output>{useNetworkStatus()}</output>
    }
    for (const navigatorValue of [undefined, { onLine: false }]) {
      vi.stubGlobal('navigator', navigatorValue)
      expect(renderToString(<Probe />)).toBe('<output>online</output>')
    }
  })

  it('cancels the reconnection notice if the browser goes offline again', () => {
    const { result } = renderHook(() => useNetworkStatus())
    act(() => window.dispatchEvent(new Event('offline')))
    act(() => window.dispatchEvent(new Event('online')))
    expect(result.current).toBe('reconnected')
    act(() => vi.advanceTimersByTime(4_000))
    act(() => window.dispatchEvent(new Event('offline')))
    act(() => vi.advanceTimersByTime(5_000))
    expect(result.current).toBe('offline')
  })

  it('removes its exact event listeners and pending timer on unmount', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = renderHook(() => useNetworkStatus())
    act(() => window.dispatchEvent(new Event('offline')))
    act(() => window.dispatchEvent(new Event('online')))
    expect(vi.getTimerCount()).toBe(1)
    const handlers = add.mock.calls.filter(([name]) => name === 'offline' || name === 'online')
    unmount()
    expect(vi.getTimerCount()).toBe(0)
    for (const [name, handler] of handlers) expect(remove).toHaveBeenCalledWith(name, handler)
  })
})
