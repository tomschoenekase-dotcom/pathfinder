'use client'

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

        if (!disposed) {
          setVenue(result)
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

      try {
        const result = await client.chat.session.mutate({
          venueId: venue.id,
          anonymousToken,
          ...(lat !== null ? { lat } : {}),
          ...(lng !== null ? { lng } : {}),
        })

        if (!disposed) {
          setSessionId(result.sessionId)
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
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md space-y-4 rounded-3xl border border-white/10 bg-slate-900/70 p-8 text-center text-slate-100 shadow-2xl shadow-cyan-950/30">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">PathFinder</p>
          <h1 className="text-3xl font-semibold tracking-tight text-white">
            Loading venue chat...
          </h1>
          <p className="text-sm leading-6 text-slate-300">
            Getting the venue assistant ready for your visit.
          </p>
        </div>
      </main>
    )
  }

  if (!venue) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="max-w-md space-y-4 rounded-3xl border border-white/10 bg-slate-900/70 p-8 text-center text-slate-100 shadow-2xl shadow-cyan-950/30">
          <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">PathFinder</p>
          <h1 className="text-3xl font-semibold tracking-tight">Venue unavailable</h1>
          <p className="text-sm leading-6 text-slate-300">
            {pageError ?? 'This venue link is not active.'}
          </p>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center justify-center rounded-full border border-cyan-400/40 px-5 text-sm font-medium text-cyan-100 transition hover:border-cyan-300 hover:bg-cyan-400/10"
          >
            Back to home
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 pb-[env(safe-area-inset-bottom,1.5rem)] pt-6 sm:px-6">
      <header className="mb-4 rounded-[2rem] border border-white/10 bg-slate-900/65 p-5 shadow-2xl shadow-cyan-950/30 backdrop-blur">
        <p className="text-xs uppercase tracking-[0.3em] text-cyan-300">
          {venue.category ?? 'Venue assistant'}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white">{venue.name}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-300">
          {venue.description ?? 'Ask where things are, what to do next, or what is nearby.'}
        </p>
      </header>

      <LocationBanner permission={permission} onRefresh={refresh} />

      {messages.length === 0 ? (
        <>
          <section className="mb-4 rounded-[2rem] border border-white/10 bg-slate-900/65 p-5 shadow-xl backdrop-blur">
            <h2 className="text-2xl font-semibold tracking-tight text-slate-100">
              Hi! I&apos;m your {venue.name} guide.
            </h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Ask me anything about the venue — I&apos;ll point you in the right direction.
            </p>
          </section>
          <QuickPromptChips
            venueName={venue.name}
            venueCategory={venue.category ?? undefined}
            onSend={(prompt) => {
              void handleSend(prompt)
            }}
          />
        </>
      ) : null}

      <ChatWindow
        messages={messages}
        onSend={(message) => {
          void handleSend(message)
        }}
        isLoading={isSending}
        errorMessage={sendError}
        onPlaceCardView={(placeId) => {
          if (viewedPlaceIdsRef.current.has(placeId)) {
            return
          }

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
    </main>
  )
}
