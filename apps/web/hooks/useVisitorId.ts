'use client'

import { useEffect, useState } from 'react'

import { browserUuid } from '../lib/browser-uuid'

const STORAGE_KEY = 'pathfinder_visitor_id'

function generateVisitorId() {
  return browserUuid() ?? ''
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

    let existing: string | null = null
    try {
      existing = window.localStorage.getItem(STORAGE_KEY)
    } catch {
      // Some private or embedded mobile contexts expose storage but reject access.
    }

    if (existing && UUID_RE.test(existing)) {
      setVisitorId(existing)
      return
    }

    const next = generateVisitorId()

    if (next) {
      try {
        window.localStorage.setItem(STORAGE_KEY, next)
      } catch {
        // Keep the visitor identity in memory for this page.
      }
      setVisitorId(next)
    }
  }, [])

  return visitorId
}
