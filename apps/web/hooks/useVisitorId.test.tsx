import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useVisitorId } from './useVisitorId'

describe('useVisitorId', () => {
  beforeEach(() => window.localStorage.clear())

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('uses cryptographic bytes when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(2)
        return bytes
      },
    })

    const visitor = renderHook(() => useVisitorId())

    await waitFor(() => expect(visitor.result.current).toBe('02020202-0202-4202-8202-020202020202'))
  })

  it('keeps an in-memory identity when mobile storage access is rejected', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(3)
        return bytes
      },
    })

    const visitor = renderHook(() => useVisitorId())

    await waitFor(() => expect(visitor.result.current).toBe('03030303-0303-4303-8303-030303030303'))
  })
})
