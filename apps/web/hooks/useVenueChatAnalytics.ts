'use client'

import { useCallback, useEffect, useRef } from 'react'

import type { VenueSummary } from '../components/venue-chat-types'
import { useTRPCClient } from '../lib/trpc'

type PlaceEvent = 'place_card.viewed' | 'place_card.clicked' | 'directions.opened'

export function useVenueChatAnalytics({
  venue,
  anonymousToken,
  visitorId,
}: {
  venue: VenueSummary | null
  anonymousToken: string | null
  visitorId: string | null
}) {
  const client = useTRPCClient()
  const sessionStartedAtRef = useRef<number | null>(null)
  const startedSessionKeyRef = useRef<string | null>(null)
  const viewedPlaceIdsRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!venue || !anonymousToken) return
    const sessionKey = `${venue.id}:${anonymousToken}`
    if (startedSessionKeyRef.current === sessionKey) return
    startedSessionKeyRef.current = sessionKey
    sessionStartedAtRef.current = Date.now()
    void client.analytics.trackEvent
      .mutate({
        venueId: venue.id,
        sessionId: anonymousToken,
        ...(visitorId ? { visitorId } : {}),
        eventType: 'session.started',
      })
      .catch(() => {})
  }, [anonymousToken, client, venue, visitorId])

  const endSession = useCallback(
    (venueId: string, token: string, startedAt: number | null) => {
      const durationSeconds =
        startedAt === null ? 0 : Math.max(0, Math.round((Date.now() - startedAt) / 1000))
      void client.analytics.trackEvent
        .mutate({
          venueId,
          sessionId: token,
          ...(visitorId ? { visitorId } : {}),
          eventType: 'session.ended',
          metadata: { durationSeconds },
        })
        .catch(() => {})
    },
    [client, visitorId],
  )

  useEffect(() => {
    if (!venue || !anonymousToken) return
    const venueId = venue.id
    function handleBeforeUnload() {
      endSession(venueId, anonymousToken!, sessionStartedAtRef.current)
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [anonymousToken, endSession, venue])

  const trackPlaceEvent = useCallback(
    (eventType: PlaceEvent, placeId: string) => {
      if (!venue || !anonymousToken) return
      void client.analytics.trackEvent
        .mutate({
          venueId: venue.id,
          sessionId: anonymousToken,
          ...(visitorId ? { visitorId } : {}),
          eventType,
          placeId,
        })
        .catch(() => {})
    },
    [anonymousToken, client, venue, visitorId],
  )

  const resetAnalytics = useCallback(() => {
    startedSessionKeyRef.current = null
    sessionStartedAtRef.current = null
    viewedPlaceIdsRef.current.clear()
  }, [])

  return { endSession, resetAnalytics, sessionStartedAtRef, trackPlaceEvent, viewedPlaceIdsRef }
}
