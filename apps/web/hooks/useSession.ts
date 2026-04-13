'use client'

import { useEffect, useState } from 'react'

type SessionHookState = {
  anonymousToken: string
  sessionId: string | null
  setSessionId: (id: string) => void
}

function generateAnonymousToken() {
  // randomUUID is available in modern secure browser contexts, which this PWA also
  // needs for geolocation permissions to work reliably.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `pathfinder-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function useSession(venueId: string): SessionHookState {
  const [anonymousToken, setAnonymousToken] = useState('')
  const [sessionId, setSessionIdState] = useState<string | null>(null)

  useEffect(() => {
    if (!venueId || typeof window === 'undefined') {
      return
    }

    const storageKey = `pathfinder_session_${venueId}`
    const existing = window.sessionStorage.getItem(storageKey)

    if (existing) {
      setAnonymousToken(existing)
      return
    }

    const nextToken = generateAnonymousToken()
    window.sessionStorage.setItem(storageKey, nextToken)
    setAnonymousToken(nextToken)
  }, [venueId])

  function setSessionId(id: string) {
    setSessionIdState(id)
  }

  return {
    anonymousToken,
    sessionId,
    setSessionId,
  }
}
