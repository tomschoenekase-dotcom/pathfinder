'use client'

import Link from 'next/link'
import dynamic from 'next/dynamic'
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import type { CharacterState } from '@pathfinder/contracts/character-system'
import { parseChatAppearance } from '@pathfinder/contracts/chat-appearance'
import type { GuestVisitorAction } from '@pathfinder/contracts/guest-response'
import { CHAT_FONT_OPTIONS, getChatPalette, resolveChatAppearance } from '@pathfinder/ui/theme'

import { ChatWindow } from './ChatWindow'
import styles from './visitor-chat.module.css'
import { ConnectionStatusBanner } from './ConnectionStatusBanner'
import {
  LANGUAGE_FALLBACK_DESCRIPTIONS,
  LANGUAGE_HEADINGS,
  LANGUAGE_PLACEHOLDERS,
  getChatLanguagePresentation,
} from './LanguagePicker'
import { LocationBanner } from './LocationBanner'
import { QuickPromptChips } from './QuickPromptChips'
import { VenueCharacterBoundary } from './VenueCharacterBoundary'
import { VenueCharacterFallback } from './VenueCharacterFallback'
import type { GuestVisitContextInput } from '@pathfinder/contracts/guest-visit-context'
import {
  VoiceControl,
  type FinalizedVoiceTranscriptLine,
  type LiveAssistantCaption,
} from './VoiceControl'
import { VisitorSettings } from './VisitorSettings'
import { getVisitorSettingsCopy } from './visitor-settings-copy'
import { getVisitorStateCopy, getVisitorUiCopy, localizeVisitorShellError } from './visitor-ui-copy'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'
import type { NetworkConnectionState } from '../hooks/useNetworkStatus'
import { useChatViewportHeight } from '../hooks/useChatViewportHeight'
import {
  DEFAULT_VISITOR_PREFERENCES,
  VISITOR_TEXT_SCALE,
  type VisitorPreferences,
} from '../lib/visitor-preferences'
import { chatAppearanceStyle } from '../lib/chat-appearance-style'
import { useHostBridge } from '../lib/use-host-bridge'

const LazyVenueCharacterStage = dynamic(
  () => import('./VenueCharacterStage').then((module) => module.VenueCharacterStage),
  {
    ssr: false,
    loading: () => <VenueCharacterFallback status="loading" />,
  },
)

// The Space Museum's reviewed launch artwork is bundled locally, never loaded from media intake.
// Explicit background and high contrast choices take precedence over this presentation.
const SPACE_MUSEUM_VENUE_ID = 'cmsg624n70003rx0190j8o941'

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
      className="h-8 w-8 flex-shrink-0 rounded-lg object-contain"
      onError={() => setFailed(true)}
    />
  )
}

type ImageLoad = { src: string | null; status: 'loading' | 'ready' | 'failed' }

/** Tracks one decorative image; failure falls back to the plain theme surface. */
function useImageLoad(src: string | null) {
  const [load, setLoad] = useState<ImageLoad>({ src: null, status: 'loading' })
  const status = load.src === src ? load.status : 'loading'
  const inspect = useCallback(
    (image: HTMLImageElement | null) => {
      if (!image?.complete || !src) return
      setLoad({ src, status: image.naturalWidth > 0 ? 'ready' : 'failed' })
    },
    [src],
  )
  return {
    status,
    inspect,
    onLoad: () => setLoad({ src, status: 'ready' }),
    onError: () => setLoad({ src, status: 'failed' }),
  }
}

/** Keeps the page itself from rubber-banding; only the transcript scrolls. */
function useDocumentScrollLock() {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.visitorChat = ''
    return () => {
      delete root.dataset.visitorChat
    }
  }, [])
}

export function VenueChatShell(props: {
  venue: VenueSummary
  venueSlug: string
  presentation: VenueChatPresentation
  appHeader?: 'full' | 'compact' | 'none'
  bridgeOrigins?: readonly string[] | undefined
  onBridgePlace?: (placeId: string) => void
  messages: ChatMessage[]
  isSending: boolean
  sendError: string | null
  anonymousToken: string | null
  /** Resolved interface language (a manual choice or the browser language under Auto). */
  language: SupportedChatLanguage
  preferences?: VisitorPreferences
  onPreferencesChange?: (change: Partial<VisitorPreferences>) => void
  initialDraft: string
  characterState?: CharacterState
  characterMotion?: 'system' | 'reduced' | 'full'
  location: {
    lat: number | null
    lng: number | null
    permission: Parameters<typeof LocationBanner>[0]['permission']
    refresh: () => void
  }
  onSend: (message: string) => void | boolean
  onRequestMore?: () => void
  requestMoreLabel?: string
  onDraftChange?: (draft: string) => void
  onRetry?: (() => void) | null
  retryLabel?: string
  onStopResponse?: () => void
  stopResponseLabel?: string
  conversationLocked?: boolean
  isRestoringHistory?: boolean
  onNewConversation: () => void
  onPlaceView: (placeId: string) => void
  onPlaceClick: (placeId: string) => void
  onDirections: (placeId: string) => void
  onVoiceCharacterState?: (state: CharacterState) => void
  onVoiceTranscriptLine?: (line: FinalizedVoiceTranscriptLine) => void
  onVisitorAction?: (action: GuestVisitorAction) => void
  voiceControl?: ReactNode
  fixtureLiveVoiceCaption?: LiveAssistantCaption | null
  fixtureLiveVoiceAnnouncement?: string | null
  visitContext?: GuestVisitContextInput
  routePlanner?: ReactNode
  connectionState?: NetworkConnectionState
}) {
  const {
    venue,
    venueSlug,
    presentation,
    appHeader = 'full',
    bridgeOrigins,
    onBridgePlace,
    messages,
    isSending,
    sendError,
    anonymousToken,
    language,
    preferences = DEFAULT_VISITOR_PREFERENCES,
    onPreferencesChange = () => undefined,
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
    isRestoringHistory = false,
    onNewConversation,
    onPlaceView,
    onPlaceClick,
    onDirections,
    onVoiceCharacterState,
    onVoiceTranscriptLine,
    onVisitorAction,
    voiceControl,
    fixtureLiveVoiceCaption,
    fixtureLiveVoiceAnnouncement,
    visitContext,
    routePlanner,
    connectionState = 'online',
  } = props
  const [voiceEligible, setVoiceEligible] = useState(false)
  const [voiceConversationEnabled, setVoiceConversationEnabled] = useState(true)
  const currentVenueIdRef = useRef(venue.id)
  currentVenueIdRef.current = venue.id
  const [voiceVenueScope, setVoiceVenueScope] = useState(venue.id)
  const [liveVoiceCaption, setLiveVoiceCaption] = useState<{
    venueId: string
    caption: LiveAssistantCaption | null
  } | null>(null)
  const [liveVoiceAnnouncement, setLiveVoiceAnnouncement] = useState<{
    venueId: string
    text: string
    sequence: number
  } | null>(null)
  const handleLiveVoiceCaptionChange = useCallback(
    (caption: LiveAssistantCaption | null) => {
      if (currentVenueIdRef.current !== venue.id) return
      setLiveVoiceCaption({ venueId: venue.id, caption })
    },
    [venue.id],
  )
  const handleVoiceAvailabilityChange = useCallback(
    (available: boolean) => {
      setVoiceEligible(available)
      setVoiceVenueScope(venue.id)
    },
    [venue.id],
  )
  const handleVoiceCaptionAnnouncement = useCallback(
    (announcement: 'started' | 'interrupted') => {
      if (currentVenueIdRef.current !== venue.id) return
      setLiveVoiceAnnouncement((current) => ({
        venueId: venue.id,
        text:
          announcement === 'interrupted'
            ? 'Voice response interrupted. Finalizing caption.'
            : 'Voice caption started.',
        sequence: (current?.venueId === venue.id ? current.sequence : 0) + 1,
      }))
    },
    [venue.id],
  )
  useEffect(() => {
    setVoiceEligible(false)
    setVoiceConversationEnabled(true)
    setVoiceVenueScope(venue.id)
    setLiveVoiceCaption(null)
    setLiveVoiceAnnouncement(null)
  }, [venue.id])
  const scopedLiveVoiceCaption =
    liveVoiceCaption?.venueId === venue.id ? liveVoiceCaption.caption : null
  const scopedLiveVoiceAnnouncement =
    liveVoiceAnnouncement?.venueId === venue.id ? liveVoiceAnnouncement : null
  useDocumentScrollLock()
  const bridge = useHostBridge({
    presentation,
    allowedOrigins: bridgeOrigins,
    onPlace: onBridgePlace,
  })
  const isOnline = connectionState !== 'offline'
  const compactAppHeader = presentation === 'webview' && appHeader === 'compact'
  const viewportHeight = useChatViewportHeight()
  const appearance = parseChatAppearance(venue.chatAppearance)
  const museumStarfield =
    venue.id === SPACE_MUSEUM_VENUE_ID &&
    venue.chatTheme === 'dark' &&
    appearance.background.mode === 'none' &&
    !preferences.highContrast
  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const languagePresentation = getChatLanguagePresentation(language)
  const shellCopy = getVisitorUiCopy(language).shell
  const backLabel = shellCopy[1]
  const clearChatLabel = shellCopy[2]
  const aiGuidance = shellCopy[12]
  const poweredByLabel = shellCopy[13]
  const settingsCopy = getVisitorSettingsCopy(language)
  const hasLocation =
    venue.guideMode !== 'non_location' && location.lat !== null && location.lng !== null
  const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
  const title = appearance.title ?? venue.name
  const canSubmitMessage =
    isOnline && !isSending && Boolean(anonymousToken) && !conversationLocked && !isRestoringHistory

  function sendGuestMessage(message: string) {
    if (!canSubmitMessage) return false
    return onSend(message)
  }

  const bannerUrl = venue.chatBannerUrl
  const bannerLoad = useImageLoad(bannerUrl)
  const wantsBackdrop = appearance.background.mode === 'image' && Boolean(bannerUrl)
  const backdropReady = wantsBackdrop && bannerLoad.status === 'ready'
  const tokens = resolveChatAppearance(palette, appearance, {
    hasBackgroundImage: backdropReady,
    highContrast: preferences.highContrast,
  })
  // Without a chosen background, a reviewed banner keeps its original header placement.
  const headerBanner =
    !wantsBackdrop && !compactAppHeader && !preferences.highContrast && Boolean(bannerUrl)
  const headerBannerReady = headerBanner && bannerLoad.status === 'ready'
  const publicCharacter = venue.venueBotPresentation?.character
  const characterPresentation =
    venue.venueBotPresentation?.mode === 'CHARACTER' && publicCharacter
      ? { ...venue.venueBotPresentation, character: publicCharacter }
      : null
  const characterExpanded = messages.length === 0

  return (
    <div
      ref={bridge.shellRef}
      inert={!bridge.hostOpen}
      aria-hidden={!bridge.hostOpen || undefined}
      lang={languagePresentation.code}
      dir={languagePresentation.direction}
      className={`${styles.shell} flex flex-col`}
      data-keyboard-open={viewportHeight !== undefined ? true : undefined}
      data-text-size={preferences.textSize}
      data-contrast={preferences.highContrast ? 'high' : 'standard'}
      data-speaker-labels={tokens.speakerLabels ? true : undefined}
      data-backdrop={tokens.backgroundImage ? 'image' : 'none'}
      data-starry={museumStarfield ? true : undefined}
      style={
        {
          backgroundColor: tokens.pageBg,
          height: viewportHeight?.height,
          '--chat-keyboard-offset-x': `${viewportHeight?.offsetLeft ?? 0}px`,
          '--chat-keyboard-offset-y': `${viewportHeight?.offsetTop ?? 0}px`,
          '--chat-keyboard-composer-max':
            viewportHeight !== undefined
              ? `${Math.max(44, Math.min(96, Math.floor(viewportHeight.height * 0.2)))}px`
              : undefined,
          '--chat-text-scale': VISITOR_TEXT_SCALE[preferences.textSize],
          fontFamily: fontFamily(venue.chatFont),
          ...chatAppearanceStyle(palette, tokens, preferences.highContrast),
        } as CSSProperties
      }
    >
      {!(presentation === 'webview' && appHeader === 'none') ? (
        <header
          className={`${styles.header} relative overflow-hidden pt-[env(safe-area-inset-top,0px)]`}
          data-branding-banner-state={headerBanner ? bannerLoad.status : 'none'}
          data-app-header={presentation === 'webview' ? appHeader : undefined}
        >
          {headerBanner && bannerLoad.status !== 'failed' ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={bannerUrl}
              ref={bannerLoad.inspect}
              src={bannerUrl!}
              alt=""
              className={`absolute inset-0 h-full w-full object-cover ${headerBannerReady ? 'opacity-100' : 'opacity-0'}`}
              onLoad={bannerLoad.onLoad}
              onError={bannerLoad.onError}
            />
          ) : null}
          {headerBannerReady ? (
            <span aria-hidden="true" className="absolute inset-0 bg-black/65" />
          ) : null}
          <div
            className={`${styles.headerInner} relative z-10 mx-auto max-w-2xl`}
            data-on-banner={headerBannerReady ? true : undefined}
          >
            {presentation === 'standalone' ? (
              <Link
                href={`/${venueSlug}`}
                aria-label={backLabel}
                lang={languagePresentation.code}
                dir={languagePresentation.direction}
                className={styles.back}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d={
                      languagePresentation.direction === 'rtl'
                        ? 'M4 12h15M13 6l6 6-6 6'
                        : 'M20 12H5M11 6l-6 6 6 6'
                    }
                  />
                </svg>
              </Link>
            ) : null}
            {presentation === 'webview' ? (
              <button
                type="button"
                aria-label="Close guide"
                className={styles.back}
                onClick={bridge.requestClose}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 5l14 14M19 5L5 19" />
                </svg>
              </button>
            ) : null}
            <div className={styles.identity}>
              {venue.chatLogoUrl ? (
                <ChatLogo key={venue.chatLogoUrl} src={venue.chatLogoUrl} />
              ) : null}
              <div className={styles.identityCopy}>
                <h1 lang="" dir="auto" title={title}>
                  {title}
                </h1>
                {venue.experienceLabel ? (
                  <p className={styles.experience}>{venue.experienceLabel}</p>
                ) : null}
              </div>
            </div>
          </div>
        </header>
      ) : null}
      <ConnectionStatusBanner state={connectionState} language={language} />
      <main className={`${styles.main} relative flex flex-1 flex-col`}>
        {wantsBackdrop && !preferences.highContrast && bannerLoad.status !== 'failed' ? (
          <div className={styles.backdrop} aria-hidden="true" data-state={bannerLoad.status}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              key={bannerUrl}
              ref={bannerLoad.inspect}
              src={bannerUrl!}
              alt=""
              onLoad={bannerLoad.onLoad}
              onError={bannerLoad.onError}
            />
            <span />
          </div>
        ) : null}
        {characterPresentation ? (
          <div
            className={`${styles.character} relative mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6`}
          >
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
        <div
          className={`${styles.body} relative mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col`}
        >
          <ChatWindow
            key={venue.id}
            locationAware={venue.guideMode === 'location_aware'}
            conversationTools={
              <>
                {routePlanner}
                <LocationBanner
                  permission={location.permission}
                  onRefresh={location.refresh}
                  show={venue.guideMode !== 'non_location'}
                  language={language}
                />
              </>
            }
            composerVoiceControl={
              voiceControl === undefined ? (
                isOnline ? (
                  <VoiceControl
                    venueId={venue.id}
                    anonymousToken={anonymousToken}
                    language={language}
                    disabled={isSending}
                    enabled={voiceConversationEnabled}
                    compact
                    onAvailabilityChange={handleVoiceAvailabilityChange}
                    onLiveCaptionChange={handleLiveVoiceCaptionChange}
                    onCaptionAnnouncement={handleVoiceCaptionAnnouncement}
                    {...(visitContext ? { visitContext } : {})}
                    {...(onVoiceCharacterState ? { onCharacterState: onVoiceCharacterState } : {})}
                    {...(onVoiceTranscriptLine ? { onTranscriptLine: onVoiceTranscriptLine } : {})}
                  />
                ) : null
              ) : (
                voiceControl
              )
            }
            messages={messages}
            voiceCaption={
              fixtureLiveVoiceCaption === undefined
                ? scopedLiveVoiceCaption
                : fixtureLiveVoiceCaption
            }
            voiceCaptionAnnouncement={
              fixtureLiveVoiceAnnouncement === undefined
                ? (scopedLiveVoiceAnnouncement?.text ?? null)
                : fixtureLiveVoiceAnnouncement
            }
            voiceCaptionAnnouncementKey={scopedLiveVoiceAnnouncement?.sequence ?? 0}
            language={language}
            assistantLabel={guideName}
            {...(tokens.speakerLabels ? { speakerLabels: { guide: settingsCopy.guide } } : {})}
            surfaces={{
              user: tokens.userSurface ? 'bubble' : 'none',
              assistant: tokens.assistantBubble
                ? 'bubble'
                : tokens.assistantProtected
                  ? 'protected'
                  : 'none',
            }}
            onSend={sendGuestMessage}
            {...(onRequestMore && appearance.requestMore ? { onRequestMore } : {})}
            {...(requestMoreLabel ? { requestMoreLabel } : {})}
            {...(onDraftChange ? { onDraftChange } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(retryLabel ? { retryLabel } : {})}
            {...(onStopResponse ? { onStopResponse } : {})}
            {...(stopResponseLabel ? { stopResponseLabel } : {})}
            conversationLocked={conversationLocked}
            sendDisabled={isRestoringHistory || !anonymousToken}
            {...(isRestoringHistory
              ? { restoringStatusLabel: getVisitorStateCopy(language)[0] }
              : {})}
            isLoading={isSending}
            isOnline={isOnline}
            errorMessage={localizeVisitorShellError(sendError, language)}
            accentColor={palette.accent}
            accentContrastColor={palette.accentContrast}
            placeholder={LANGUAGE_PLACEHOLDERS[language] ?? 'Ask anything about this place...'}
            initialDraft={initialDraft}
            prefill={bridge.prefill}
            draftStorageKey={
              anonymousToken ? `torchiko:visitor-draft:${venue.id}:${anonymousToken}` : null
            }
            emptyState={
              <div
                lang={languagePresentation.code}
                dir={languagePresentation.direction}
                className={styles.emptyState}
              >
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
                  disabled={!canSubmitMessage}
                  onSend={sendGuestMessage}
                />
              </div>
            }
            onPlaceCardView={onPlaceView}
            onPlaceCardClick={onPlaceClick}
            onDirectionsClick={onDirections}
            {...(onVisitorAction ? { onVisitorAction } : {})}
          />
        </div>
      </main>
      <footer className={styles.footer}>
        <VisitorSettings
          language={language}
          preferences={preferences}
          onPreferencesChange={onPreferencesChange}
          onClearChat={onNewConversation}
          clearChatDisabled={!isOnline || isSending || !anonymousToken || conversationLocked}
          clearChatLabel={clearChatLabel}
          aboutGuidance={aiGuidance}
          poweredByLabel={poweredByLabel}
          attribution={
            presentation === 'webview' ? 'none' : presentation === 'standalone' ? 'link' : 'text'
          }
          voiceAvailable={isOnline && voiceEligible && voiceVenueScope === venue.id}
          voiceConversationEnabled={voiceConversationEnabled}
          onVoiceConversationChange={setVoiceConversationEnabled}
        />
      </footer>
    </div>
  )
}
