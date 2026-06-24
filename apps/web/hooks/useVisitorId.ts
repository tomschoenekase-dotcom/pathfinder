'use client'

import { useEffect, useState } from 'react'

const STORAGE_KEY = 'pathfinder_visitor_id'

function generateVisitorId() {
  // randomUUID is available in modern secure browser contexts, which this PWA
  // already relies on for geolocation. The schema validates visitorId as a UUID,
  // so always prefer it; the timestamp form is only a last-resort fallback for
  // ancient browsers and is simply not sent when it isn't a valid UUID.
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return ''
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Persistent per-browser visitor identity stored in localStorage so it survives
 * across visits, distinct from the per-visit anonymousToken (sessionStorage).
 * Returns an empty string until resolved on the client. Only ever returns a
 * valid UUID or '' — callers should skip sending it when empty.
 */
export function useVisitorId(): string {
  const [visitorId, setVisitorId] = useState('')

  useEffect(() => {
    if (typeof window === 'undefined') {
      return
    }

    const existing = window.localStorage.getItem(STORAGE_KEY)

    if (existing && UUID_RE.test(existing)) {
      setVisitorId(existing)
      return
    }

    const next = generateVisitorId()

    if (next) {
      window.localStorage.setItem(STORAGE_KEY, next)
      setVisitorId(next)
    }
  }, [])

  return visitorId
}
