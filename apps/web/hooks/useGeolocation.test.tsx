import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useGeolocation } from './useGeolocation'

describe('useGeolocation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("sets permission to 'denied' when the browser denies access", async () => {
    let onError: PositionErrorCallback | null = null

    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: {
        query: vi.fn().mockResolvedValue({ state: 'prompt' }),
      },
    })

    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: {
        clearWatch: vi.fn(),
        watchPosition: vi.fn((_success: PositionCallback, error: PositionErrorCallback) => {
          onError = error
          return 1
        }),
      },
    })

    const { result } = renderHook(() => useGeolocation())

    await waitFor(() => {
      expect(result.current.permission).toBe('prompt')
    })

    act(() => {
      result.current.refresh()
    })

    act(() => {
      onError?.({
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        code: 1,
        message: 'denied',
      } as GeolocationPositionError)
    })

    await waitFor(() => {
      expect(result.current.permission).toBe('denied')
      expect(result.current.error).toBe('Location permission was denied.')
    })
  })
})
