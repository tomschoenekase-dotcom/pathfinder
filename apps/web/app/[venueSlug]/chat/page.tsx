'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'

import { ChatWindow } from '../../../components/ChatWindow'
import {
  getStoredLanguage,
  LANGUAGE_FALLBACK_DESCRIPTIONS,
  LANGUAGE_HEADINGS,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from '../../../components/LanguagePicker'
import { LocationBanner } from '../../../components/LocationBanner'
import { CHAT_FONT_OPTIONS, getChatPalette, PathFinderIcon } from '@pathfinder/ui'
import { QuickPromptChips } from '../../../components/QuickPromptChips'
import { useGeolocation } from '../../../hooks/useGeolocation'
import { useSession } from '../../../hooks/useSession'
import { useVisitorId } from '../../../hooks/useVisitorId'
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
  chatFont: string | null
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

function getChatFontFamily(chatFont: string | null | undefined): string {
  const option = CHAT_FONT_OPTIONS.find((f) => f.value === chatFont) ?? CHAT_FONT_OPTIONS[0]!
  return `var(${option.cssVar})`
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
  const chatPlaceholder = LANGUAGE_PLACEHOLDERS[language] ?? 'Ask anything about this place...'
  const sessionStartedAtRef = useRef<number | null>(null)
  const startedSessionKeyRef = useRef<string | null>(null)
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const viewedPlaceIdsRef = useRef<Set<string>>(new Set())
  const { lat, lng, permission, refresh } = useGeolocation()
  const { anonymousToken, setSessionId } = useSession(venue?.id ?? '')
  const visitorId = useVisitorId()

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
          try {
            const { messages: historicMessages } = await client.chat.history.query({
              venueId: result.id,
              anonymousToken: storedToken,
            })

            if (!disposed && historicMessages.length > 0) {
              setMessages(historicMessages)
            }
          } catch {
            // History load failed — start the conversation fresh rather than
            // blocking the page. The venue itself loaded successfully.
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
          ...(visitorId ? { visitorId } : {}),
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
  }, [anonymousToken, client, lat, lng, setSessionId, venue, visitorId])

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
        ...(visitorId ? { visitorId } : {}),
        eventType: 'session.started',
        metadata: {
          timestamp: new Date().toISOString(),
        },
      })
      .catch(() => {})
  }, [anonymousToken, client, venue, visitorId])

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
          ...(visitorId ? { visitorId } : {}),
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
  }, [anonymousToken, client, venue, visitorId])

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
        ...(visitorId ? { visitorId } : {}),
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
        ...(visitorId ? { visitorId } : {}),
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
      <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6">
        <div className="flex flex-col items-center gap-5 text-center">
          <PathFinderIcon className="h-10 w-10 animate-pulse" />
          <p className="text-sm font-medium text-pf-deep/60">Loading your guide...</p>
        </div>
      </main>
    )
  }

  if (!venue) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6">
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

  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const fontFamily = getChatFontFamily(venue.chatFont)
  const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
  const headerTextClass = venue.chatBannerUrl
    ? 'text-white drop-shadow-sm'
    : 'text-[var(--chat-text)]'
  const backTextClass = venue.chatBannerUrl
    ? 'text-white/75 hover:text-white'
    : 'text-[var(--chat-text-muted)] hover:text-[var(--chat-accent)]'

  return (
    <div
      className="flex h-svh flex-col overflow-hidden"
      style={{ backgroundColor: palette.bg, fontFamily }}
    >
      <style>{`
        :root {
          --chat-accent: ${palette.accent};
          --chat-accent-contrast: ${palette.accentContrast};
          --chat-surface: ${palette.bg};
          --chat-bg: ${palette.bg};
          --chat-card: ${palette.card};
          --chat-border: ${palette.border};
          --chat-text: ${palette.text};
          --chat-text-muted: ${palette.textMuted};
        }
      `}</style>
      <header
        className="border-b border-[var(--chat-border)] bg-[var(--chat-card)] px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6"
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

      <div className="mx-auto flex w-full min-h-0 max-w-2xl flex-1 flex-col px-4 sm:px-6">
        <ChatWindow
          messages={messages}
          onSend={(message) => {
            void handleSend(message)
          }}
          isLoading={isSending}
          errorMessage={sendError}
          accentColor={palette.accent}
          accentContrastColor={palette.accentContrast}
          placeholder={chatPlaceholder}
          emptyState={
            <div>
              <div className="mb-4 rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-6 shadow-sm">
                <h2 className="text-xl font-semibold text-[var(--chat-text)]">
                  {LANGUAGE_HEADINGS[language] ?? LANGUAGE_HEADINGS['English']}
                </h2>
                <p className="mt-2 text-sm leading-6 text-[var(--chat-text-muted)]">
                  {venue.description ??
                    LANGUAGE_FALLBACK_DESCRIPTIONS[language] ??
                    LANGUAGE_FALLBACK_DESCRIPTIONS['English']}
                </p>
              </div>
              <QuickPromptChips
                language={language}
                venueName={venue.name}
                venueCategory={venue.category ?? undefined}
                guideMode={venue.guideMode}
                onSend={(prompt) => {
                  void handleSend(prompt)
                }}
              />
            </div>
          }
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
        <p className="text-[10px] text-[var(--chat-text-muted)]">
          Powered by{' '}
          <a href="https://pathfinder.app" className="hover:text-[var(--chat-accent)]">
            PathFinder
          </a>
        </p>
      </div>
    </div>
  )
}
