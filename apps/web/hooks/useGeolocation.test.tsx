import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useGeolocation } from './useGeolocation'

describe('useGeolocation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('does not query or watch location while disabled', async () => {
    const query = vi.fn()
    const watchPosition = vi.fn()
    const clearWatch = vi.fn()

    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: { query },
    })
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: { clearWatch, watchPosition },
    })

    const { result } = renderHook(() => useGeolocation(false))

    await waitFor(() => expect(result.current.permission).toBe('prompt'))
    act(() => result.current.refresh())

    expect(query).not.toHaveBeenCalled()
    expect(watchPosition).not.toHaveBeenCalled()
    expect(clearWatch).not.toHaveBeenCalled()
  })

  it('starts only when enabled and clears the exact watcher and coordinates when disabled', async () => {
    let onSuccess: PositionCallback | null = null
    const query = vi.fn().mockResolvedValue({ state: 'granted' })
    const clearWatch = vi.fn()
    const watchPosition = vi.fn((success: PositionCallback) => {
      onSuccess = success
      return 17
    })

    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: { query },
    })
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: { clearWatch, watchPosition },
    })

    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useGeolocation(enabled),
      { initialProps: { enabled: false } },
    )

    expect(query).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(1))

    act(() => {
      onSuccess?.({ coords: { latitude: 40.7, longitude: -74 } } as GeolocationPosition)
    })
    await waitFor(() => expect(result.current.lat).toBe(40.7))

    rerender({ enabled: false })
    await waitFor(() => {
      expect(clearWatch).toHaveBeenCalledWith(17)
      expect(result.current.lat).toBeNull()
      expect(result.current.lng).toBeNull()
    })

    act(() => {
      onSuccess?.({ coords: { latitude: 51.5, longitude: -0.1 } } as GeolocationPosition)
    })
    expect(result.current.lat).toBeNull()
    expect(result.current.lng).toBeNull()
  })

  it('ignores callbacks from a watcher invalidated by refresh', async () => {
    const successCallbacks: PositionCallback[] = []
    const errorCallbacks: PositionErrorCallback[] = []
    const watchPosition = vi.fn(
      (success: PositionCallback, errorCallback: PositionErrorCallback) => {
        successCallbacks.push(success)
        errorCallbacks.push(errorCallback)
        return successCallbacks.length
      },
    )

    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    })
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: { clearWatch: vi.fn(), watchPosition },
    })

    const { result } = renderHook(() => useGeolocation())
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(1))

    act(() => result.current.refresh())
    await waitFor(() => expect(watchPosition).toHaveBeenCalledTimes(2))

    act(() => {
      successCallbacks[0]?.({
        coords: { latitude: 51.5, longitude: -0.1 },
      } as GeolocationPosition)
      errorCallbacks[0]?.({
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        code: 1,
        message: 'stale denial',
      } as GeolocationPositionError)
    })

    expect(result.current.lat).toBeNull()
    expect(result.current.lng).toBeNull()
    expect(result.current.permission).toBe('loading')

    act(() => {
      successCallbacks[1]?.({
        coords: { latitude: 40.7, longitude: -74 },
      } as GeolocationPosition)
    })
    await waitFor(() => expect(result.current.lat).toBe(40.7))
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

  it('clears a prior position when the active watch loses access', async () => {
    let onSuccess: PositionCallback | null = null
    let onError: PositionErrorCallback | null = null
    Object.defineProperty(globalThis.navigator, 'permissions', {
      configurable: true,
      value: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
    })
    Object.defineProperty(globalThis.navigator, 'geolocation', {
      configurable: true,
      value: {
        clearWatch: vi.fn(),
        watchPosition: vi.fn((success: PositionCallback, error: PositionErrorCallback) => {
          onSuccess = success
          onError = error
          return 9
        }),
      },
    })

    const { result } = renderHook(() => useGeolocation())
    await waitFor(() => expect(onSuccess).not.toBeNull())

    act(() => {
      onSuccess?.({ coords: { latitude: 40.7, longitude: -74 } } as GeolocationPosition)
    })
    await waitFor(() => expect(result.current.lat).toBe(40.7))

    act(() => {
      onError?.({
        PERMISSION_DENIED: 1,
        POSITION_UNAVAILABLE: 2,
        TIMEOUT: 3,
        code: 2,
        message: 'unavailable',
      } as GeolocationPositionError)
    })

    await waitFor(() => {
      expect(result.current.lat).toBeNull()
      expect(result.current.lng).toBeNull()
      expect(result.current.permission).toBe('prompt')
    })
  })
})
