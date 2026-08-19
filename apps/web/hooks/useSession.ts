'use client'

import { useCallback, useEffect, useState } from 'react'

import { browserUuid } from '../lib/browser-uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SessionHookState = {
  anonymousToken: string
  sessionId: string | null
  identityUnavailable: boolean
  setSessionId: (id: string | null) => void
  startNewConversation: () => boolean
}

function generateAnonymousToken() {
  return browserUuid() ?? ''
}

export function useSession(venueId: string, experienceScope = 'public'): SessionHookState {
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

    const storageKey =
      experienceScope === 'public'
        ? `pathfinder_session_${venueId}`
        : `pathfinder_session_${venueId}_${experienceScope}`
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
  }, [experienceScope, venueId])

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
      const storageKey =
        experienceScope === 'public'
          ? `pathfinder_session_${venueId}`
          : `pathfinder_session_${venueId}_${experienceScope}`
      window.sessionStorage.setItem(storageKey, nextToken)
    } catch {
      // Continue with the new in-memory UUID when storage is unavailable.
    }
    setAnonymousSession({ venueId, token: nextToken })
    setSessionIdState(null)
    setIdentityUnavailable(false)
    return true
  }, [experienceScope, venueId])

  return {
    anonymousToken,
    sessionId,
    identityUnavailable,
    setSessionId,
    startNewConversation,
  }
}
