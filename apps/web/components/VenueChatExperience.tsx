'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { GuestPlaceCard } from '@pathfinder/api'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'

import { ChatWindow } from './ChatWindow'
import {
  getStoredLanguage,
  getChatLanguagePresentation,
  LANGUAGE_FALLBACK_DESCRIPTIONS,
  LANGUAGE_HEADINGS,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  SUPPORTED_LANGUAGES,
} from './LanguagePicker'
import { LocationBanner } from './LocationBanner'
import { CHAT_FONT_OPTIONS, getChatPalette, PathFinderIcon } from '@pathfinder/ui'
import { QuickPromptChips } from './QuickPromptChips'
import { useGeolocation } from '../hooks/useGeolocation'
import { useSession } from '../hooks/useSession'
import { useVisitorId } from '../hooks/useVisitorId'
import { useTRPCClient } from '../lib/trpc'
import { classifyPublicVenueLookupError } from '../lib/public-venue-error'
import { VenueTemporarilyUnavailable } from './VenueTemporarilyUnavailable'

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

type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
  places?: GuestPlaceCard[]
}

function getChatFontFamily(chatFont: string | null | undefined): string {
  const option = CHAT_FONT_OPTIONS.find((f) => f.value === chatFont) ?? CHAT_FONT_OPTIONS[0]!
  return `var(${option.cssVar})`
}

type VenueChatExperienceProps = {
  venueSlug: string
  presentation?: 'standalone' | 'embed' | 'webview'
  initialDraft?: string
}

export function VenueChatExperience({
  venueSlug,
  presentation = 'standalone',
  initialDraft = '',
}: VenueChatExperienceProps) {
  const client = useTRPCClient()
  const [venueState, setVenueState] = useState<{
    slug: string
    venue: VenueSummary | null
  } | null>(null)
  const venue = venueState?.slug === venueSlug ? venueState.venue : null
  const isVenueTransition = venueState?.slug !== venueSlug
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [isBooting, setIsBooting] = useState(true)
  const [isSending, setIsSending] = useState(false)
  const [pageError, setPageError] = useState<string | null>(null)
  const [isVenueUnavailable, setIsVenueUnavailable] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [language, setLanguage] = useState<SupportedChatLanguage>(() => {
    const stored = getStoredLanguage()
    const match = SUPPORTED_LANGUAGES.find(
      (supportedLanguage) => supportedLanguage.label === stored,
    )
    return match ? match.label : 'English'
  })
  const chatPlaceholder = LANGUAGE_PLACEHOLDERS[language] ?? 'Ask anything about this place...'
  const languagePresentation = getChatLanguagePresentation(language)
  const sessionStartedAtRef = useRef<number | null>(null)
  const startedSessionKeyRef = useRef<string | null>(null)
  const lastSyncedPosRef = useRef<{ lat: number; lng: number } | null>(null)
  const viewedPlaceIdsRef = useRef<Set<string>>(new Set())
  const conversationEpochRef = useRef(0)
  const sendingEpochRef = useRef<number | null>(null)
  const { lat, lng, permission, refresh } = useGeolocation(
    venue !== null && venue.guideMode !== 'non_location',
  )
  const { anonymousToken, identityUnavailable, setSessionId, startNewConversation } = useSession(
    venue?.id ?? '',
  )
  const visitorId = useVisitorId()

  useEffect(() => {
    if (venue && identityUnavailable) {
      setSendError('This browser cannot create a private chat session.')
    }
  }, [identityUnavailable, venue])

  useEffect(() => {
    let disposed = false
    const conversationEpoch = ++conversationEpochRef.current

    async function run() {
      if (!venueSlug) {
        return
      }

      setIsBooting(true)
      setPageError(null)
      setIsVenueUnavailable(false)
      setMessages([])
      setSendError(null)
      setIsSending(false)
      sendingEpochRef.current = null
      startedSessionKeyRef.current = null
      sessionStartedAtRef.current = null
      lastSyncedPosRef.current = null
      viewedPlaceIdsRef.current.clear()

      try {
        const result = await client.venue.getBySlug.query({ slug: venueSlug })

        if (disposed || conversationEpochRef.current !== conversationEpoch) {
          return
        }

        setVenueState({ slug: venueSlug, venue: result })

        let storedToken: string | null = null
        if (typeof window !== 'undefined') {
          try {
            storedToken = window.sessionStorage.getItem(`pathfinder_session_${result.id}`)
          } catch {
            // Storage may be unavailable; the session hook will use in-memory identity.
          }
        }

        if (storedToken) {
          try {
            const { messages: historicMessages } = await client.chat.history.query({
              venueId: result.id,
              anonymousToken: storedToken,
            })

            if (
              !disposed &&
              conversationEpochRef.current === conversationEpoch &&
              historicMessages.length > 0
            ) {
              setMessages(historicMessages)
            }
          } catch {
            // History load failed — start the conversation fresh rather than
            // blocking the page. The venue itself loaded successfully.
          }
        }
      } catch (error) {
        if (!disposed && conversationEpochRef.current === conversationEpoch) {
          const failure = classifyPublicVenueLookupError(error)
          setIsVenueUnavailable(failure === 'temporarily-unavailable')
          setPageError(
            failure === 'not-found'
              ? 'We could not find this venue.'
              : 'We could not load this venue. Please try again.',
          )
          setVenueState({ slug: venueSlug, venue: null })
        }
      } finally {
        if (!disposed && conversationEpochRef.current === conversationEpoch) {
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

      if (lat === null || lng === null) {
        lastSyncedPosRef.current = null
      }

      if (lat !== null && lng !== null && lastSyncedPosRef.current !== null) {
        const dLat = Math.abs(lat - lastSyncedPosRef.current.lat)
        const dLng = Math.abs(lng - lastSyncedPosRef.current.lng)
        if (dLat < 0.0001 && dLng < 0.0001) {
          return
        }
      }

      const conversationEpoch = conversationEpochRef.current

      try {
        const result = await client.chat.session.mutate({
          venueId: venue.id,
          anonymousToken,
          ...(visitorId ? { visitorId } : {}),
          ...(venue.guideMode !== 'non_location' && lat !== null && lng !== null
            ? { lat, lng }
            : {}),
        })

        if (!disposed && conversationEpochRef.current === conversationEpoch) {
          setSessionId(result.sessionId)
          if (lat !== null && lng !== null) {
            lastSyncedPosRef.current = { lat, lng }
          }
        }
      } catch (error) {
        if (!disposed && conversationEpochRef.current === conversationEpoch) {
          if (classifyPublicVenueLookupError(error) === 'temporarily-unavailable') {
            setIsVenueUnavailable(true)
          } else {
            setSendError('We could not prepare the chat session. Please try again.')
          }
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

    const location =
      venue.guideMode === 'non_location' ? null : lat !== null && lng !== null ? { lat, lng } : null
    const requestedLanguage = language

    setSendError(null)
    setIsSending(true)
    setMessages((current) => [...current, { role: 'user', content: trimmed }])
    const sendingEpoch = conversationEpochRef.current
    sendingEpochRef.current = sendingEpoch

    try {
      const result = await client.chat.send.mutate({
        venueId: venue.id,
        anonymousToken,
        ...(visitorId ? { visitorId } : {}),
        message: trimmed,
        ...(location ?? {}),
        ...(requestedLanguage === 'English' ? {} : { language: requestedLanguage }),
      })

      if (conversationEpochRef.current === sendingEpoch) {
        setMessages((current) => [
          ...current,
          { role: 'assistant', content: result.response, places: result.places },
        ])
        setSessionId(result.sessionId)
      }
    } catch (error) {
      if (conversationEpochRef.current !== sendingEpoch) {
        return
      }
      if (classifyPublicVenueLookupError(error) === 'temporarily-unavailable') {
        setIsVenueUnavailable(true)
      } else {
        setSendError('That message did not send. Please try again.')
      }
    } finally {
      if (sendingEpochRef.current === sendingEpoch) {
        sendingEpochRef.current = null
        setIsSending(false)
      }
    }
  }

  function handleNewConversation() {
    if (!venue || !anonymousToken || isSending) {
      return
    }

    if (
      messages.length > 0 &&
      !window.confirm(
        'Start a new conversation? The current chat will leave this screen, but it will not be deleted from PathFinder records.',
      )
    ) {
      return
    }

    const previousToken = anonymousToken
    const previousStartedAt = sessionStartedAtRef.current
    if (!startNewConversation()) {
      setSendError('We could not start a new conversation in this browser.')
      return
    }

    conversationEpochRef.current += 1
    sendingEpochRef.current = null
    setMessages([])
    setSendError(null)
    startedSessionKeyRef.current = null
    sessionStartedAtRef.current = null
    lastSyncedPosRef.current = null
    viewedPlaceIdsRef.current.clear()

    const durationSeconds =
      previousStartedAt === null
        ? 0
        : Math.max(0, Math.round((Date.now() - previousStartedAt) / 1000))
    void client.analytics.trackEvent
      .mutate({
        venueId: venue.id,
        sessionId: previousToken,
        ...(visitorId ? { visitorId } : {}),
        eventType: 'session.ended',
        metadata: { durationSeconds },
      })
      .catch(() => {})
  }

  if (isBooting || isVenueTransition) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-pf-surface px-6">
        <div className="flex flex-col items-center gap-5 text-center">
          <PathFinderIcon className="h-10 w-10 animate-pulse" />
          <p className="text-sm font-medium text-pf-deep/60">Loading your guide...</p>
        </div>
      </main>
    )
  }

  if (isVenueUnavailable) {
    return <VenueTemporarilyUnavailable showHomeLink={presentation === 'standalone'} />
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
            {presentation === 'standalone' ? (
              <Link
                href="/"
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-pf-light px-5 text-sm font-medium text-pf-primary transition hover:border-pf-accent"
              >
                Back to home
              </Link>
            ) : null}
          </div>
        </div>
      </main>
    )
  }

  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const hasLocationContext = venue.guideMode !== 'non_location' && lat !== null && lng !== null
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
          {presentation === 'standalone' ? (
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
          ) : null}
          <div
            className={
              presentation === 'standalone'
                ? 'mt-2 flex items-center gap-3'
                : 'flex items-center gap-3'
            }
          >
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
          <div className="mt-2 flex items-center justify-between gap-3">
            <LanguagePicker value={language} onChange={setLanguage} />
            <button
              type="button"
              onClick={handleNewConversation}
              disabled={isSending || !anonymousToken}
              className="inline-flex min-h-9 items-center justify-center rounded-full border border-current px-3 text-xs font-medium opacity-80 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              New conversation
            </button>
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
          initialDraft={initialDraft}
          emptyState={
            <div lang={languagePresentation.code} dir={languagePresentation.direction}>
              <div className="mb-4 rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-6 shadow-sm">
                <h2 className="text-xl font-semibold text-[var(--chat-text)]">
                  {LANGUAGE_HEADINGS[language] ?? LANGUAGE_HEADINGS['English']}
                </h2>
                <p
                  className="mt-2 text-sm leading-6 text-[var(--chat-text-muted)]"
                  lang={venue.description ? '' : languagePresentation.code}
                  dir={venue.description ? 'auto' : languagePresentation.direction}
                >
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
                locationAvailable={hasLocationContext}
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
        <p
          className="mx-auto max-w-2xl px-4 text-[11px] leading-4 text-[var(--chat-text-muted)] sm:px-6"
          role="note"
          aria-label="AI guidance"
        >
          AI-generated answers can be wrong. Verify important details with venue staff, and do not
          share sensitive information.
        </p>
        {presentation !== 'webview' ? (
          <p className="text-[10px] text-[var(--chat-text-muted)]">
            Powered by{' '}
            {presentation === 'standalone' ? (
              <a href="https://pathfinder.app" className="hover:text-[var(--chat-accent)]">
                PathFinder
              </a>
            ) : (
              <span>PathFinder</span>
            )}
          </p>
        ) : null}
      </div>
    </div>
  )
}
