'use client'

import Image from 'next/image'
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { ChatWindow } from '../../../components/ChatWindow'
import { LocationBanner } from '../../../components/LocationBanner'
import { QuickPromptChips } from '../../../components/QuickPromptChips'
import { useGeolocation } from '../../../hooks/useGeolocation'
import { useSession } from '../../../hooks/useSession'
import { createTRPCClient } from '../../../lib/trpc'

type VenueSummary = {
  id: string
  name: string
  description: string | null
  category: string | null
  defaultCenterLat: number | null
  defaultCenterLng: number | null
}

type PlaceSummary = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  distanceMeters: number
  lat: number
  lng: number
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  places?: PlaceSummary[]
}

function useApiClient() {
  const clientRef = useRef<ReturnType<typeof createTRPCClient> | null>(null)

  if (clientRef.current === null) {
    clientRef.current = createTRPCClient()
  }

  return clientRef.current
}

export default function VenueChatPage() {
  const params = useParams<{ venueSlug: string }>()
  const venueSlug = params.venueSlug
  const client = useApiClient()
  const [venue, setVenue] = useState<VenueSummary | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isBooting, setIsBooting] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const sessionStartedAtRef = useRef<number | null>(null)
  const startedSessionKeyRef = useRef<string | null>(null)
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const viewedPlaceIdsRef = useRef<Set<string>>(new Set())
  const { lat, lng, permission, refresh } = useGeolocation()
  const { anonymousToken, setSessionId } = useSession(venue?.id ?? '')

  useEffect(() => {
    let disposed = false

    async function run() {
      if (!venueSlug) {
        return
      }

      setIsBooting(true)
      setPageError(null)

      try {
        const result = await client.venue.getBySlug.query({ slug: venueSlug })

        if (disposed) {
          return
        }

        setVenue(result)

        const storedToken =
          typeof window !== 'undefined'
            ? window.sessionStorage.getItem(`pathfinder_session_${result.id}`)
            : null

        if (storedToken) {
          const { messages: historicMessages } = await client.chat.history.query({
            venueId: result.id,
            anonymousToken: storedToken,
          })

          if (!disposed && historicMessages.length > 0) {
            setMessages(historicMessages)
          }
        }
      } catch {
        if (!disposed) {
          setPageError('We could not find this venue.')
          setVenue(null)
        }
      } finally {
        if (!disposed) {
          setIsBooting(false)
        }
      }
    }

    void run()

    return () => {
      disposed = true
    }
  }, [client, venueSlug])

  useEffect(() => {
    let disposed = false

    async function ensureSession() {
      if (!venue || !anonymousToken) {
        return
      }

      if (lat !== null && lng !== null && lastSyncedPosRef.current !== null) {
        const dLat = Math.abs(lat - lastSyncedPosRef.current.lat)
        const dLng = Math.abs(lng - lastSyncedPosRef.current.lng)
        if (dLat < 0.0001 && dLng < 0.0001) {
          return
        }
      }

      try {
        const result = await client.chat.session.mutate({
          venueId: venue.id,
          anonymousToken,
          ...(lat !== null ? { lat } : {}),
          ...(lng !== null ? { lng } : {}),
        })

        if (!disposed) {
          setSessionId(result.sessionId)
          if (lat !== null && lng !== null) {
            lastSyncedPosRef.current = { lat, lng }
          }
        }
      } catch {
        if (!disposed) {
          setSendError('We could not prepare the chat session. Please try again.')
        }
      }
    }

    void ensureSession()

    return () => {
      disposed = true
    }
  }, [anonymousToken, client, lat, lng, setSessionId, venue])

  useEffect(() => {
    if (!venue || !anonymousToken) {
      return
    }

    const sessionKey = `${venue.id}:${anonymousToken}`
    if (startedSessionKeyRef.current === sessionKey) {
      return
    }

    startedSessionKeyRef.current = sessionKey
    sessionStartedAtRef.current = Date.now()

    void client.analytics.trackEvent
      .mutate({
        venueId: venue.id,
        sessionId: anonymousToken,
        eventType: 'session.started',
        metadata: {
          timestamp: new Date().toISOString(),
        },
      })
      .catch(() => {})
  }, [anonymousToken, client, venue])

  useEffect(() => {
    if (!venue || !anonymousToken) {
      return
    }

    const venueId = venue.id

    function handleBeforeUnload() {
      const durationSeconds =
        sessionStartedAtRef.current === null
          ? 0
          : Math.max(0, Math.round((Date.now() - sessionStartedAtRef.current) / 1000))

      void client.analytics.trackEvent
        .mutate({
          venueId,
          sessionId: anonymousToken,
          eventType: 'session.ended',
          metadata: {
            durationSeconds,
          },
        })
        .catch(() => {})
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [anonymousToken, client, venue])

  function trackPlaceEvent(
    eventType: 'place_card.viewed' | 'place_card.clicked' | 'directions.opened',
    placeId: string,
  ) {
    if (!venue || !anonymousToken) {
      return
    }

    void client.analytics.trackEvent
      .mutate({
        venueId: venue.id,
        sessionId: anonymousToken,
        eventType,
        placeId,
      })
      .catch(() => {})
  }

  async function handleSend(message: string) {
    const trimmed = message.trim()

    if (!venue || !anonymousToken || !trimmed || isSending) {
      return
    }

    const fallbackLat = lat ?? venue.defaultCenterLat
    const fallbackLng = lng ?? venue.defaultCenterLng

    if (fallbackLat === null || fallbackLng === null) {
      setSendError('Location is still unavailable for this venue. Try allowing location first.')
      return
    }

    setSendError(null)
    setIsSending(true)
    setMessages((current) => [...current, { role: 'user', content: trimmed }])

    try {
      const result = await client.chat.send.mutate({
        venueId: venue.id,
        anonymousToken,
        message: trimmed,
        lat: fallbackLat,
        lng: fallbackLng,
      })

      setMessages((current) => [
        ...current,
        { role: 'assistant', content: result.response, places: result.places },
      ])
      setSessionId(result.sessionId)
    } catch {
      setSendError('That message did not send. Please try again.')
    } finally {
      setIsSending(false)
    }
  }

  if (isBooting) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
        <div className="flex flex-col items-center gap-5 text-center">
          <Image
            src="/pathfinder-icon.svg"
            alt=""
            width={40}
            height={40}
            className="animate-pulse"
          />
          <p className="text-sm font-medium text-pf-deep/60">Loading your guide...</p>
        </div>
      </main>
    )
  }

  if (!venue) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-pf-surface px-6">
        <div className="w-full max-w-md rounded-3xl border border-pf-light bg-pf-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold text-pf-deep">Venue unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-pf-deep/60">
            {pageError ?? 'This venue link is not active.'}
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
          >
            Back to home
          </Link>
        </div>
      </main>
    )
  }

  return (
    <div className="flex min-h-screen flex-col bg-pf-surface">
      <header className="border-b border-pf-light bg-pf-white px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6">
        <div className="mx-auto max-w-2xl py-4">
          <Link
            href={`/${venueSlug}`}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-pf-deep/40 transition hover:text-pf-primary"
          >
            <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path
                fillRule="evenodd"
                d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
            Back
          </Link>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-pf-deep">
            {venue.name} Guide
          </h1>
          {venue.category ? (
            <p className="mt-1 text-xs font-semibold uppercase tracking-widest text-pf-accent">
              {venue.category.toLowerCase().replace(/_/g, ' ')}
            </p>
          ) : null}
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
        <LocationBanner permission={permission} onRefresh={refresh} />
      </div>

      {messages.length === 0 ? (
        <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
          <div className="mb-4 rounded-3xl border border-pf-light bg-pf-white p-6 shadow-sm">
            <h2 className="text-xl font-semibold text-pf-deep">What can I help you find?</h2>
            <p className="mt-2 text-sm leading-6 text-pf-deep/60">
              {venue.description ??
                'Ask about exhibits, food, restrooms, directions, or anything nearby.'}
            </p>
          </div>
          <QuickPromptChips
            venueName={venue.name}
            venueCategory={venue.category ?? undefined}
            onSend={(prompt) => {
              void handleSend(prompt)
            }}
          />
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 sm:px-6">
        <ChatWindow
          messages={messages}
          onSend={(message) => {
            void handleSend(message)
          }}
          isLoading={isSending}
          errorMessage={sendError}
          onPlaceCardView={(placeId) => {
            if (viewedPlaceIdsRef.current.has(placeId)) return
            viewedPlaceIdsRef.current.add(placeId)
            trackPlaceEvent('place_card.viewed', placeId)
          }}
          onPlaceCardClick={(placeId) => {
            trackPlaceEvent('place_card.clicked', placeId)
          }}
          onDirectionsClick={(placeId) => {
            trackPlaceEvent('directions.opened', placeId)
          }}
        />
      </div>

      <div className="pb-[env(safe-area-inset-bottom,1rem)] pt-2 text-center">
        <p className="text-[10px] text-pf-deep/25">
          Powered by{' '}
          <a href="https://pathfinder.app" className="hover:text-pf-primary">
            PathFinder
          </a>
        </p>
      </div>
    </div>
  )
}
