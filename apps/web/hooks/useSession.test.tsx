import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSession } from './useSession'

describe('useSession', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns the same token across multiple calls for the same venueId', async () => {
    const token = '00000000-0000-4000-8000-000000000001'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(token)

    const first = renderHook(() => useSession('venue_1'))

    await waitFor(() => {
      expect(first.result.current.anonymousToken).toBe(token)
    })

    first.unmount()

    const second = renderHook(() => useSession('venue_1'))

    await waitFor(() => {
      expect(second.result.current.anonymousToken).toBe(token)
    })
  })

  it('replaces malformed stored identities with an API-valid UUID', async () => {
    const token = '00000000-0000-4000-8000-000000000002'
    window.sessionStorage.setItem('pathfinder_session_venue_1', 'legacy-invalid-token')
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(token)

    const session = renderHook(() => useSession('venue_1'))

    await waitFor(() => expect(session.result.current.anonymousToken).toBe(token))
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1')).toBe(token)
  })

  it('generates a UUID v4 with cryptographic bytes when randomUUID is unavailable', async () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.forEach((_, index) => {
          bytes[index] = index
        })
        return bytes
      },
    })

    const session = renderHook(() => useSession('venue_1'))

    await waitFor(() => {
      expect(session.result.current.anonymousToken).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
    })
  })

  it('falls back to cryptographic bytes when randomUUID throws', async () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => {
        throw new DOMException('Unavailable', 'NotSupportedError')
      },
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(1)
        return bytes
      },
    })

    const session = renderHook(() => useSession('venue_1'))

    await waitFor(() =>
      expect(session.result.current.anonymousToken).toBe('01010101-0101-4101-8101-010101010101'),
    )
  })

  it('fails reset closed when no cryptographic identity source exists', async () => {
    vi.stubGlobal('crypto', {})

    const session = renderHook(() => useSession('venue_1'))
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(''))

    expect(session.result.current.identityUnavailable).toBe(true)
    expect(session.result.current.startNewConversation()).toBe(false)
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1')).toBeNull()
  })

  it('continues with an in-memory UUID when sessionStorage writes are denied', async () => {
    const firstToken = '00000000-0000-4000-8000-000000000013'
    const secondToken = '00000000-0000-4000-8000-000000000014'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage denied', 'SecurityError')
    })

    const session = renderHook(() => useSession('venue_1'))
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(firstToken))

    act(() => {
      expect(session.result.current.startNewConversation()).toBe(true)
    })
    expect(session.result.current.anonymousToken).toBe(secondToken)
  })

  it('starts a distinct conversation and clears its server session id', async () => {
    const firstToken = '00000000-0000-4000-8000-000000000003'
    const secondToken = '00000000-0000-4000-8000-000000000004'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken)

    const session = renderHook(() => useSession('venue_1'))
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(firstToken))

    act(() => session.result.current.setSessionId('server-session-1'))
    expect(session.result.current.sessionId).toBe('server-session-1')

    act(() => {
      expect(session.result.current.startNewConversation()).toBe(true)
    })

    expect(session.result.current.anonymousToken).toBe(secondToken)
    expect(session.result.current.sessionId).toBeNull()
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1')).toBe(secondToken)
  })

  it('never exposes a previous venue identity after the venue changes', async () => {
    const firstToken = '00000000-0000-4000-8000-000000000005'
    const secondToken = '00000000-0000-4000-8000-000000000006'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken)

    const session = renderHook(({ venueId }) => useSession(venueId), {
      initialProps: { venueId: 'venue_1' },
    })
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(firstToken))

    session.rerender({ venueId: 'venue_2' })
    expect(session.result.current.anonymousToken).not.toBe(firstToken)
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(secondToken))
  })

  it('clears exposed state and fences captured callbacks when the experience scope changes', async () => {
    const publicToken = '00000000-0000-4000-8000-000000000015'
    const secondLayerToken = '00000000-0000-4000-8000-000000000016'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(publicToken)
      .mockReturnValueOnce(secondLayerToken)

    const capturedRenders: Array<{ anonymousToken: string; sessionId: string | null }> = []
    const session = renderHook(
      ({ scope }) => {
        const output = useSession('venue_1', scope)
        capturedRenders.push(output)
        return output
      },
      {
        initialProps: { scope: 'public' },
      },
    )
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(publicToken))
    const staleScopeCallback = session.result.current.setSessionId

    act(() => staleScopeCallback('public-session'))
    expect(session.result.current.sessionId).toBe('public-session')

    const rendersBeforeScopeSwitch = capturedRenders.length
    session.rerender({ scope: 'second-layer' })
    const switchedRenders = capturedRenders.slice(rendersBeforeScopeSwitch)
    expect(switchedRenders[0]).toMatchObject({ anonymousToken: '', sessionId: null })
    expect(
      switchedRenders.every(
        (output) => output.anonymousToken !== publicToken && output.sessionId !== 'public-session',
      ),
    ).toBe(true)

    act(() => staleScopeCallback('stale-session'))
    expect(session.result.current.sessionId).toBeNull()

    await waitFor(() => expect(session.result.current.anonymousToken).toBe(secondLayerToken))
    act(() => session.result.current.setSessionId('second-layer-session'))
    expect(session.result.current.sessionId).toBe('second-layer-session')
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1')).toBe(publicToken)
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1_second-layer')).toBe(
      secondLayerToken,
    )
  })

  it('fences a setSessionId callback captured before starting a new conversation', async () => {
    const firstToken = '00000000-0000-4000-8000-000000000017'
    const secondToken = '00000000-0000-4000-8000-000000000018'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(firstToken)
      .mockReturnValueOnce(secondToken)

    const session = renderHook(() => useSession('venue_1'))
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(firstToken))
    const staleResetCallback = session.result.current.setSessionId

    act(() => {
      expect(session.result.current.startNewConversation()).toBe(true)
    })
    expect(session.result.current.anonymousToken).toBe(secondToken)
    expect(session.result.current.sessionId).toBeNull()

    act(() => staleResetCallback('stale-session'))
    expect(session.result.current.sessionId).toBeNull()
    act(() => session.result.current.setSessionId('new-session'))
    expect(session.result.current.sessionId).toBe('new-session')
  })

  it('fences a stale reset callback before it can generate or store an old-scope token', async () => {
    const publicToken = '00000000-0000-4000-8000-000000000019'
    const secondLayerToken = '00000000-0000-4000-8000-000000000020'
    const staleResetToken = '00000000-0000-4000-8000-000000000021'
    vi.spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValueOnce(publicToken)
      .mockReturnValueOnce(secondLayerToken)
      .mockReturnValueOnce(staleResetToken)

    const session = renderHook(({ scope }) => useSession('venue_1', scope), {
      initialProps: { scope: 'public' },
    })
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(publicToken))
    const staleReset = session.result.current.startNewConversation

    session.rerender({ scope: 'second-layer' })
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(secondLayerToken))

    act(() => expect(staleReset()).toBe(false))
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1')).toBe(publicToken)
    expect(window.sessionStorage.getItem('pathfinder_session_venue_1_second-layer')).toBe(
      secondLayerToken,
    )
    expect(session.result.current.anonymousToken).toBe(secondLayerToken)
  })

  it('preserves the active session when reset identity generation fails', async () => {
    const token = '00000000-0000-4000-8000-000000000022'
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(token)

    const session = renderHook(() => useSession('venue_1'))
    await waitFor(() => expect(session.result.current.anonymousToken).toBe(token))
    act(() => session.result.current.setSessionId('active-session'))

    vi.stubGlobal('crypto', {})
    act(() => expect(session.result.current.startNewConversation()).toBe(false))
    expect(session.result.current.anonymousToken).toBe(token)
    expect(session.result.current.sessionId).toBe('active-session')
    expect(session.result.current.identityUnavailable).toBe(true)
  })
})
