'use client'

import { useCallback, useEffect, useState } from 'react'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SessionHookState = {
  anonymousToken: string
  sessionId: string | null
  identityUnavailable: boolean
  setSessionId: (id: string | null) => void
  startNewConversation: () => boolean
}

function generateAnonymousToken() {
  // randomUUID is available in modern secure browser contexts, which this PWA also
  // needs for geolocation permissions to work reliably.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try {
      const token = globalThis.crypto.randomUUID()
      if (UUID_RE.test(token)) {
        return token
      }
    } catch {
      // Fall through to getRandomValues when the platform implementation fails.
    }
  }

  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    return ''
  }

  let bytes: Uint8Array
  try {
    bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  } catch {
    return ''
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function useSession(venueId: string): SessionHookState {
  const [anonymousSession, setAnonymousSession] = useState({ venueId: '', token: '' })
  const [sessionId, setSessionIdState] = useState<string | null>(null)
  const [identityUnavailable, setIdentityUnavailable] = useState(false)
  const anonymousToken = anonymousSession.venueId === venueId ? anonymousSession.token : ''

  useEffect(() => {
    if (!venueId || typeof window === 'undefined') {
      setAnonymousSession({ venueId: '', token: '' })
      setSessionIdState(null)
      setIdentityUnavailable(false)
      return
    }

    const storageKey = `pathfinder_session_${venueId}`
    let existing: string | null = null
    try {
      existing = window.sessionStorage.getItem(storageKey)
    } catch {
      // Session storage can be disabled. Keep an in-memory UUID for this page.
    }

    if (existing && UUID_RE.test(existing)) {
      setAnonymousSession({ venueId, token: existing })
      setSessionIdState(null)
      setIdentityUnavailable(false)
      return
    }

    const nextToken = generateAnonymousToken()
    if (nextToken) {
      try {
        window.sessionStorage.setItem(storageKey, nextToken)
      } catch {
        // The in-memory identity still provides a valid session for this page.
      }
    }
    setAnonymousSession({ venueId, token: nextToken })
    setSessionIdState(null)
    setIdentityUnavailable(!nextToken)
  }, [venueId])

  const setSessionId = useCallback((id: string | null) => {
    setSessionIdState(id)
  }, [])

  const startNewConversation = useCallback(() => {
    if (!venueId || typeof window === 'undefined') {
      return false
    }

    const nextToken = generateAnonymousToken()
    if (!nextToken) {
      setIdentityUnavailable(true)
      return false
    }

    try {
      window.sessionStorage.setItem(`pathfinder_session_${venueId}`, nextToken)
    } catch {
      // Continue with the new in-memory UUID when storage is unavailable.
    }
    setAnonymousSession({ venueId, token: nextToken })
    setSessionIdState(null)
    setIdentityUnavailable(false)
    return true
  }, [venueId])

  return {
    anonymousToken,
    sessionId,
    identityUnavailable,
    setSessionId,
    startNewConversation,
  }
}
