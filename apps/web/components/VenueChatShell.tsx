'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useCallback, useState, type CSSProperties, type ReactNode } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'
import type { GuestVisitorAction } from '@pathfinder/contracts/guest-response'
import { CHAT_FONT_OPTIONS, getChatPalette } from '@pathfinder/ui/theme'

import { ChatWindow } from './ChatWindow'
import styles from './visitor-chat.module.css'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import {
  LANGUAGE_FALLBACK_DESCRIPTIONS,
  LANGUAGE_HEADINGS,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  getChatLanguagePresentation,
} from './LanguagePicker'
import { LocationBanner } from './LocationBanner'
import { QuickPromptChips } from './QuickPromptChips'
import { VenueCharacterBoundary } from './VenueCharacterBoundary'
import { VenueCharacterFallback } from './VenueCharacterFallback'
import { VoiceControl, type FinalizedVoiceTranscriptLine } from './VoiceControl'
import { getVisitorUiCopy, localizeVisitorShellError } from './visitor-ui-copy'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'
import type { NetworkConnectionState } from '../hooks/useNetworkStatus'
import { useChatViewportHeight } from '../hooks/useChatViewportHeight'

const LazyVenueCharacterStage = dynamic(
  () => import('./VenueCharacterStage').then((module) => module.VenueCharacterStage),
  {
    ssr: false,
    loading: () => <VenueCharacterFallback status="loading" />,
  },
)

function fontFamily(chatFont: string | null): string {
  const option = CHAT_FONT_OPTIONS.find((font) => font.value === chatFont) ?? CHAT_FONT_OPTIONS[0]!
  return `var(${option.cssVar})`
}

function ChatLogo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  const inspectCachedImage = useCallback((image: HTMLImageElement | null) => {
    if (image?.complete && image.naturalWidth === 0) setFailed(true)
  }, [])

  if (failed) return null

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={inspectCachedImage}
      src={src}
      alt=""
      className="h-8 w-8 rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  )
}

export function VenueChatShell(props: {
  venue: VenueSummary
  venueSlug: string
  presentation: VenueChatPresentation
  messages: ChatMessage[]
  isSending: boolean
  sendError: string | null
  anonymousToken: string | null
  language: SupportedChatLanguage
  setLanguage: (language: SupportedChatLanguage) => void
  initialDraft: string
  characterState?: CharacterState
  characterMotion?: 'system' | 'reduced' | 'full'
  location: {
    lat: number | null
    lng: number | null
    permission: Parameters<typeof LocationBanner>[0]['permission']
    refresh: () => void
  }
  onSend: (message: string) => void
  onRequestMore?: () => void
  requestMoreLabel?: string
  onDraftChange?: (draft: string) => void
  onRetry?: (() => void) | null
  retryLabel?: string
  onStopResponse?: () => void
  stopResponseLabel?: string
  conversationLocked?: boolean
  onNewConversation: () => void
  onPlaceView: (placeId: string) => void
  onPlaceClick: (placeId: string) => void
  onDirections: (placeId: string) => void
  onVoiceCharacterState?: (state: CharacterState) => void
  onVoiceTranscriptLine?: (line: FinalizedVoiceTranscriptLine) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  onMessageFeedback?: (messageId: string, rating: 'HELPFUL' | 'NOT_HELPFUL') => Promise<void>
  voiceControl?: ReactNode
  routePlanner?: ReactNode
  connectionState?: NetworkConnectionState
}) {
  const {
    venue,
    venueSlug,
    presentation,
    messages,
    isSending,
    sendError,
    anonymousToken,
    language,
    setLanguage,
    initialDraft,
    characterState = 'idle',
    characterMotion = 'system',
    location,
    onSend,
    onRequestMore,
    requestMoreLabel,
    onDraftChange,
    onRetry,
    retryLabel,
    onStopResponse,
    stopResponseLabel,
    conversationLocked = false,
    onNewConversation,
    onPlaceView,
    onPlaceClick,
    onDirections,
    onVoiceCharacterState,
    onVoiceTranscriptLine,
    onVisitorAction,
    onMessageFeedback,
    voiceControl,
    routePlanner,
    connectionState = 'online',
  } = props
  const isOnline = connectionState !== 'offline'
  const viewportHeight = useChatViewportHeight()
  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const languagePresentation = getChatLanguagePresentation(language)
  const [
    ,
    backLabel,
    newConversationLabel,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    ,
    aiGuidanceLabel,
    aiGuidance,
    poweredByLabel,
  ] = getVisitorUiCopy(language).shell
  const hasLocation =
    venue.guideMode !== 'non_location' && location.lat !== null && location.lng !== null
  const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
  const [bannerLoad, setBannerLoad] = useState<{
    src: string | null
    status: 'loading' | 'ready' | 'failed'
  }>({ src: null, status: 'loading' })
  const bannerUrl = venue.chatBannerUrl
  const bannerStatus = bannerLoad.src === bannerUrl ? bannerLoad.status : 'loading'
  const banner = Boolean(bannerUrl && bannerStatus === 'ready')
  const inspectCachedBanner = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image?.complete || !bannerUrl) return
      setBannerLoad({
        src: bannerUrl,
        status: image.naturalWidth > 0 ? 'ready' : 'failed',
      })
    },
    [bannerUrl],
  )
  const publicCharacter = venue.venueBotPresentation?.character
  const characterPresentation =
    venue.venueBotPresentation?.mode === 'CHARACTER' && publicCharacter
      ? { ...venue.venueBotPresentation, character: publicCharacter }
      : null
  const characterExpanded = messages.length === 0

  return (
    <div
      lang={languagePresentation.code}
      dir={languagePresentation.direction}
      className={`${styles.shell} flex flex-col`}
      data-keyboard-open={viewportHeight !== undefined || undefined}
      style={
        {
          backgroundColor: palette.bg,
          height: viewportHeight,
          '--chat-keyboard-composer-max':
            viewportHeight !== undefined
              ? `${Math.max(44, Math.min(96, Math.floor(viewportHeight * 0.2)))}px`
              : undefined,
          fontFamily: fontFamily(venue.chatFont),
          '--chat-accent': palette.accent,
          '--chat-accent-text': palette.accentText,
          '--chat-accent-contrast': palette.accentContrast,
          '--chat-surface': palette.bg,
          '--chat-bg': palette.bg,
          '--chat-card': palette.card,
          '--chat-border': palette.border,
          '--chat-text': palette.text,
          '--chat-text-muted': palette.textMuted,
        } as CSSProperties
      }
    >
      <header
        className={`${styles.header} relative overflow-hidden border-b border-[var(--chat-border)] bg-[var(--chat-card)] px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6`}
        data-branding-banner-state={bannerUrl ? bannerStatus : 'none'}
      >
        {bannerUrl && bannerStatus !== 'failed' ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={bannerUrl}
            ref={inspectCachedBanner}
            src={bannerUrl}
            alt=""
            className={`absolute inset-0 h-full w-full object-cover ${banner ? 'opacity-100' : 'opacity-0'}`}
            onLoad={() => setBannerLoad({ src: bannerUrl, status: 'ready' })}
            onError={() => setBannerLoad({ src: bannerUrl, status: 'failed' })}
          />
        ) : null}
        {banner ? <span aria-hidden="true" className="absolute inset-0 bg-black/65" /> : null}
        <div className={`${styles.headerInner} relative z-10 mx-auto max-w-2xl`}>
          {presentation === 'standalone' ? (
            <Link
              href={`/${venueSlug}`}
              lang={languagePresentation.code}
              dir={languagePresentation.direction}
              className={`${styles.back} inline-flex min-h-11 items-center gap-1.5 text-xs font-medium transition ${banner ? 'text-white/75 hover:text-white' : 'text-[var(--chat-text-muted)] hover:text-[var(--chat-accent-text)]'}`}
            >
              <span aria-hidden="true">{languagePresentation.direction === 'rtl' ? '→' : '←'}</span>{' '}
              {backLabel}
            </Link>
          ) : null}
          <div className={`${styles.identity} flex items-center`}>
            {venue.chatLogoUrl ? (
              <ChatLogo key={venue.chatLogoUrl} src={venue.chatLogoUrl} />
            ) : null}
            <h1
              lang=""
              dir="auto"
              className={`text-2xl font-semibold tracking-tight ${banner ? 'text-white drop-shadow-sm' : 'text-[var(--chat-text)]'}`}
            >
              {guideName}
            </h1>
            {venue.experienceLabel ? (
              <span
                className={`rounded-full px-2.5 py-1 text-xs font-semibold ${banner ? 'bg-white/20 text-white' : 'bg-[var(--chat-accent)] text-[var(--chat-accent-contrast)]'}`}
              >
                {venue.experienceLabel}
              </span>
            ) : null}
          </div>
          <div className={`${styles.toolbar} flex items-center justify-between`}>
            <LanguagePicker value={language} onChange={setLanguage} />
            <button
              type="button"
              onClick={onNewConversation}
              disabled={!isOnline || isSending || !anonymousToken || conversationLocked}
              className={`inline-flex min-h-11 items-center justify-center rounded-full border border-current px-3 text-xs font-medium opacity-80 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40 ${banner ? 'text-white' : 'text-[var(--chat-text)]'}`}
            >
              {newConversationLabel}
            </button>
          </div>
        </div>
      </header>
      <ConnectionStatusBanner state={connectionState} language={language} />
      <main className={`${styles.main} flex flex-1 flex-col`}>
        {characterPresentation ? (
          <div className={`${styles.character} mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6`}>
            <VenueCharacterBoundary
              resetKey={`${characterPresentation.character.characterId}:${characterPresentation.character.assetPackId}:${characterPresentation.character.assetPackVersion}`}
              compact={!characterExpanded}
            >
              <LazyVenueCharacterStage
                projection={characterPresentation.character}
                state={characterState}
                displayName={characterPresentation.displayName}
                greeting={characterPresentation.greeting}
                expanded={characterExpanded}
                motion={characterMotion}
              />
            </VenueCharacterBoundary>
          </div>
        ) : null}
        <div className={`${styles.body} mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col`}>
          {routePlanner}
          {voiceControl === undefined ? (
            isOnline ? (
              <VoiceControl
                venueId={venue.id}
                anonymousToken={anonymousToken}
                language={language}
                disabled={isSending}
                {...(onVoiceCharacterState ? { onCharacterState: onVoiceCharacterState } : {})}
                {...(onVoiceTranscriptLine ? { onTranscriptLine: onVoiceTranscriptLine } : {})}
              />
            ) : null
          ) : (
            voiceControl
          )}
          <ChatWindow
            conversationTools={
              <LocationBanner
                permission={location.permission}
                onRefresh={location.refresh}
                show={venue.guideMode !== 'non_location'}
                language={language}
              />
            }
            messages={messages}
            language={language}
            assistantLabel={guideName}
            onSend={onSend}
            {...(onRequestMore ? { onRequestMore } : {})}
            {...(requestMoreLabel ? { requestMoreLabel } : {})}
            {...(onDraftChange ? { onDraftChange } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(retryLabel ? { retryLabel } : {})}
            {...(onStopResponse ? { onStopResponse } : {})}
            {...(stopResponseLabel ? { stopResponseLabel } : {})}
            conversationLocked={conversationLocked}
            isLoading={isSending}
            isOnline={isOnline}
            errorMessage={localizeVisitorShellError(sendError, language)}
            accentColor={palette.accent}
            accentContrastColor={palette.accentContrast}
            placeholder={LANGUAGE_PLACEHOLDERS[language] ?? 'Ask anything about this place...'}
            initialDraft={initialDraft}
            emptyState={
              <div lang={languagePresentation.code} dir={languagePresentation.direction}>
                <div className={styles.welcome}>
                  <h2 className="text-xl font-semibold text-[var(--chat-text)]">
                    {LANGUAGE_HEADINGS[language] ?? LANGUAGE_HEADINGS.English}
                  </h2>
                  <p
                    className="mt-2 text-sm leading-6 text-[var(--chat-text-muted)]"
                    lang={venue.description ? '' : languagePresentation.code}
                    dir={venue.description ? 'auto' : languagePresentation.direction}
                  >
                    {venue.description ??
                      LANGUAGE_FALLBACK_DESCRIPTIONS[language] ??
                      LANGUAGE_FALLBACK_DESCRIPTIONS.English}
                  </p>
                </div>
                <QuickPromptChips
                  language={language}
                  venueName={venue.name}
                  venueCategory={venue.category ?? undefined}
                  guideMode={venue.guideMode}
                  locationAvailable={hasLocation}
                  disabled={!isOnline || conversationLocked}
                  onSend={onSend}
                />
              </div>
            }
            onPlaceCardView={onPlaceView}
            onPlaceCardClick={onPlaceClick}
            onDirectionsClick={onDirections}
            {...(onVisitorAction ? { onVisitorAction } : {})}
            {...(onMessageFeedback ? { onMessageFeedback } : {})}
          />
        </div>
      </main>
      <footer className={styles.footer}>
        <div className={styles.footerRow}>
          {presentation !== 'webview' ? (
            <span>
              {poweredByLabel}{' '}
              {presentation === 'standalone' ? (
                <a
                  href="https://torchiko.com"
                  className="inline-flex min-h-11 min-w-11 items-center font-medium hover:underline"
                >
                  Torchiko
                </a>
              ) : (
                <span>Torchiko</span>
              )}
            </span>
          ) : null}
          <details className={styles.guidance}>
            <summary lang={languagePresentation.code} dir={languagePresentation.direction}>
              {aiGuidanceLabel}
            </summary>
            <p
              role="note"
              aria-label={aiGuidanceLabel}
              lang={languagePresentation.code}
              dir={languagePresentation.direction}
            >
              {aiGuidance}
            </p>
          </details>
        </div>
      </footer>
    </div>
  )
}
