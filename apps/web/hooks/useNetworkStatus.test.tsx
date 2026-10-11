import React from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
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

  it.each([true, false])(
    'hydrates server HTML before detecting browser online=%s',
    async (online) => {
      function Connection() {
        return <div>{useNetworkStatus()}</div>
      }

      // Modern Node exposes navigator but does not implement browser connectivity.
      Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: undefined })
      const html = renderToString(<Connection />)
      expect(html).toBe('<div>online</div>')
      const container = document.createElement('div')
      container.innerHTML = html
      document.body.appendChild(container)
      setNavigatorOnline(online)
      const onRecoverableError = vi.fn()
      let root: ReturnType<typeof hydrateRoot> | undefined
      try {
        await act(async () => {
          root = hydrateRoot(container, <Connection />, { onRecoverableError })
        })
        expect(container.textContent).toBe(online ? 'online' : 'offline')
        expect(onRecoverableError).not.toHaveBeenCalled()
      } finally {
        act(() => root?.unmount())
        container.remove()
      }
    },
  )
})
