'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { browserUuid } from '../lib/browser-uuid'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type SessionHookState = {
  anonymousToken: string
  sessionId: string | null
  identityUnavailable: boolean
  setSessionId: (id: string | null) => void
  startNewConversation: () => boolean
}

type SessionState = {
  scopeKey: string
  anonymousToken: string
  sessionId: string | null
  identityUnavailable: boolean
}

function generateAnonymousToken() {
  return browserUuid() ?? ''
}

export function useSession(venueId: string, experienceScope = 'public'): SessionHookState {
  const scopeKey = `${venueId}\u0000${experienceScope}`
  const [sessionState, setSessionState] = useState<SessionState>({
    scopeKey: '',
    anonymousToken: '',
    sessionId: null,
    identityUnavailable: false,
  })
  const lifecycleRef = useRef(0)
  const scopeKeyRef = useRef(scopeKey)
  if (scopeKeyRef.current !== scopeKey) {
    scopeKeyRef.current = scopeKey
    lifecycleRef.current += 1
  }
  const lifecycle = lifecycleRef.current
  const anonymousToken = sessionState.scopeKey === scopeKey ? sessionState.anonymousToken : ''
  const sessionId = sessionState.scopeKey === scopeKey ? sessionState.sessionId : null
  const identityUnavailable =
    sessionState.scopeKey === scopeKey ? sessionState.identityUnavailable : false

  useEffect(() => {
    if (!venueId || typeof window === 'undefined') {
      if (scopeKeyRef.current !== scopeKey) return
      setSessionState({
        scopeKey,
        anonymousToken: '',
        sessionId: null,
        identityUnavailable: false,
      })
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
      if (scopeKeyRef.current !== scopeKey) return
      setSessionState({
        scopeKey,
        anonymousToken: existing,
        sessionId: null,
        identityUnavailable: false,
      })
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
    if (scopeKeyRef.current !== scopeKey) return
    setSessionState({
      scopeKey,
      anonymousToken: nextToken,
      sessionId: null,
      identityUnavailable: !nextToken,
    })
  }, [experienceScope, scopeKey, venueId])

  const setSessionId = useCallback(
    (id: string | null) => {
      if (scopeKeyRef.current !== scopeKey || lifecycleRef.current !== lifecycle) return
      setSessionState((previous) =>
        previous.scopeKey === scopeKey && lifecycleRef.current === lifecycle
          ? { ...previous, sessionId: id }
          : previous,
      )
    },
    [lifecycle, scopeKey],
  )

  const startNewConversation = useCallback(() => {
    if (
      !venueId ||
      typeof window === 'undefined' ||
      scopeKeyRef.current !== scopeKey ||
      lifecycleRef.current !== lifecycle
    ) {
      return false
    }

    const nextToken = generateAnonymousToken()
    if (!nextToken) {
      setSessionState((previous) =>
        previous.scopeKey === scopeKey && lifecycleRef.current === lifecycle
          ? { ...previous, identityUnavailable: true }
          : previous,
      )
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
    lifecycleRef.current += 1
    setSessionState({
      scopeKey,
      anonymousToken: nextToken,
      sessionId: null,
      identityUnavailable: false,
    })
    return true
  }, [experienceScope, lifecycle, scopeKey, venueId])

  return {
    anonymousToken,
    sessionId,
    identityUnavailable,
    setSessionId,
    startNewConversation,
  }
}
