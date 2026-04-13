import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSession } from './useSession'

describe('useSession', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the same token across multiple calls for the same venueId', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('token-1')

    const first = renderHook(() => useSession('venue_1'))

    await waitFor(() => {
      expect(first.result.current.anonymousToken).toBe('token-1')
    })

    first.unmount()

    const second = renderHook(() => useSession('venue_1'))

    await waitFor(() => {
      expect(second.result.current.anonymousToken).toBe('token-1')
    })
  })
})
