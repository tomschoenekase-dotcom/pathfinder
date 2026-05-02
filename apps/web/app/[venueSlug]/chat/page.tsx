'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { ChatWindow } from '../../../components/ChatWindow'
import {
  getStoredLanguage,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from '../../../components/LanguagePicker'
import { LocationBanner } from '../../../components/LocationBanner'
import { PathFinderIcon } from '../../../components/PathFinderBrand'
import { QuickPromptChips } from '../../../components/QuickPromptChips'
import { useGeolocation } from '../../../hooks/useGeolocation'
import { useSession } from '../../../hooks/useSession'
import { createTRPCClient } from '../../../lib/trpc'

type VenueSummary = {
  id: string
  name: string
  description: string | null
  category: string | null
  guideMode: string
  defaultCenterLat: number | null
  defaultCenterLng: number | null
  aiGuideName: string | null
  chatTheme: string | null
  chatAccentColor: string | null
  chatLogoUrl: string | null
  chatBannerUrl: string | null
}

type PlaceSummary = {
  id: string
  name: string
  type: string
  photoUrl: string | null
  distanceMeters: number | undefined
  lat: number | null
  lng: number | null
}

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  places?: PlaceSummary[]
}

const THEME_PRESETS: Record<string, { accent: string; surface: string }> = {
  default: { accent: '#3A7BD5', surface: '#F2F5F9' },
  forest: { accent: '#2D6A4F', surface: '#F0F7F4' },
  sunset: { accent: '#E07B39', surface: '#FBF4EF' },
  midnight: { accent: '#4361EE', surface: '#EEF0F8' },
  rose: { accent: '#D4607A', surface: '#FDF0F3' },
}

function isHexColor(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
}

function getThemeColors(venue: VenueSummary) {
  const preset = THEME_PRESETS[venue.chatTheme ?? 'default'] ?? {
    accent: '#3A7BD5',
    surface: '#F2F5F9',
  }
  return {
    accent: isHexColor(venue.chatAccentColor) ? venue.chatAccentColor : preset.accent,
    surface: preset.surface,
  }
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
  const [language, setLanguage] = useState<string>(() => {
    const stored = getStoredLanguage()
    const match = SUPPORTED_LANGUAGES.find(
      (supportedLanguage) => supportedLanguage.label === stored,
    )
    return match ? match.label : 'English'
  })
  const chatPlaceholder =
    LANGUAGE_PLACEHOLDERS[language] ??
    (venue?.guideMode === 'non_location'
      ? 'Ask what to know, how it works, or what to do next.'
      : 'Ask what is nearby, where to go next, or where to find amenities.')
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

    if (venue.guideMode !== 'non_location' && (fallbackLat === null || fallbackLng === null)) {
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
        ...(fallbackLat !== null ? { lat: fallbackLat } : {}),
        ...(fallbackLng !== null ? { lng: fallbackLng } : {}),
        ...(language === 'English' ? {} : { language }),
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
          <PathFinderIcon className="h-10 w-10 animate-pulse" />
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
          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-pf-primary px-5 text-sm font-medium text-white transition hover:bg-pf-accent"
            >
              Try again
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
            >
              Back to home
            </Link>
          </div>
        </div>
      </main>
    )
  }

  const { accent, surface } = getThemeColors(venue)
  const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
  const headerTextClass = venue.chatBannerUrl ? 'text-white drop-shadow-sm' : 'text-pf-deep'
  const backTextClass = venue.chatBannerUrl
    ? 'text-white/75 hover:text-white'
    : 'text-pf-deep/40 hover:text-pf-primary'

  return (
    <div className="flex min-h-screen flex-col bg-pf-surface" style={{ backgroundColor: surface }}>
      <style>{`
        :root {
          --chat-accent: ${accent};
          --chat-surface: ${surface};
        }
      `}</style>
      <header
        className="border-b border-black/10 bg-pf-white px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6"
        style={
          venue.chatBannerUrl
            ? {
                backgroundImage: `linear-gradient(rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.35)), url(${venue.chatBannerUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
              }
            : undefined
        }
      >
        <div className="mx-auto max-w-2xl py-4">
          <Link
            href={`/${venueSlug}`}
            className={`inline-flex items-center gap-1.5 text-xs font-medium transition ${backTextClass}`}
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
          <div className="mt-2 flex items-center gap-3">
            {venue.chatLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={venue.chatLogoUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
            ) : (
              <PathFinderIcon className="h-7 w-7 flex-shrink-0" />
            )}
            <h1 className={`text-2xl font-semibold tracking-tight ${headerTextClass}`}>
              {guideName}
            </h1>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <LanguagePicker value={language} onChange={setLanguage} />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
        <LocationBanner
          permission={permission}
          onRefresh={refresh}
          show={venue.guideMode !== 'non_location'}
        />
      </div>

      {messages.length === 0 && language === 'English' ? (
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
            guideMode={venue.guideMode}
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
          accentColor={accent}
          placeholder={chatPlaceholder}
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
