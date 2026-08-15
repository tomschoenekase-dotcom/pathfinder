'use client'

import Link from 'next/link'
import type { SupportedChatLanguage } from '@pathfinder/api/schemas'
import { CHAT_FONT_OPTIONS, getChatPalette, PathFinderIcon } from '@pathfinder/ui'

import { ChatWindow } from './ChatWindow'
import {
  LANGUAGE_FALLBACK_DESCRIPTIONS,
  LANGUAGE_HEADINGS,
  LANGUAGE_PLACEHOLDERS,
  LanguagePicker,
  getChatLanguagePresentation,
} from './LanguagePicker'
import { LocationBanner } from './LocationBanner'
import { QuickPromptChips } from './QuickPromptChips'
import type { ChatMessage, VenueChatPresentation, VenueSummary } from './venue-chat-types'

function fontFamily(chatFont: string | null): string {
  const option = CHAT_FONT_OPTIONS.find((font) => font.value === chatFont) ?? CHAT_FONT_OPTIONS[0]!
  return `var(${option.cssVar})`
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
  location: {
    lat: number | null
    lng: number | null
    permission: Parameters<typeof LocationBanner>[0]['permission']
    refresh: () => void
  }
  onSend: (message: string) => void
  onDraftChange?: () => void
  onRetry?: (() => void) | null
  retryLabel?: string
  onNewConversation: () => void
  onPlaceView: (placeId: string) => void
  onPlaceClick: (placeId: string) => void
  onDirections: (placeId: string) => void
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
    location,
    onSend,
    onDraftChange,
    onRetry,
    retryLabel,
    onNewConversation,
    onPlaceView,
    onPlaceClick,
    onDirections,
  } = props
  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const languagePresentation = getChatLanguagePresentation(language)
  const hasLocation =
    venue.guideMode !== 'non_location' && location.lat !== null && location.lng !== null
  const guideName = venue.aiGuideName?.trim() || `${venue.name} Guide`
  const banner = Boolean(venue.chatBannerUrl)

  return (
    <div
      className="flex h-svh flex-col overflow-hidden"
      style={{ backgroundColor: palette.bg, fontFamily: fontFamily(venue.chatFont) }}
    >
      <style>{`:root{--chat-accent:${palette.accent};--chat-accent-contrast:${palette.accentContrast};--chat-surface:${palette.bg};--chat-bg:${palette.bg};--chat-card:${palette.card};--chat-border:${palette.border};--chat-text:${palette.text};--chat-text-muted:${palette.textMuted};}`}</style>
      <header
        className="border-b border-[var(--chat-border)] bg-[var(--chat-card)] px-4 pt-[env(safe-area-inset-top,0px)] sm:px-6"
        style={
          venue.chatBannerUrl
            ? {
                backgroundImage: `linear-gradient(rgba(0,0,0,.35),rgba(0,0,0,.35)),url(${venue.chatBannerUrl})`,
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
              className={`inline-flex items-center gap-1.5 text-xs font-medium transition ${banner ? 'text-white/75 hover:text-white' : 'text-[var(--chat-text-muted)] hover:text-[var(--chat-accent)]'}`}
            >
              <span aria-hidden="true">←</span> Back
            </Link>
          ) : null}
          <div className={`${presentation === 'standalone' ? 'mt-2 ' : ''}flex items-center gap-3`}>
            {venue.chatLogoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={venue.chatLogoUrl} alt="" className="h-8 w-8 rounded-lg object-contain" />
            ) : (
              <PathFinderIcon className="h-7 w-7 flex-shrink-0" />
            )}
            <h1
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
          <div className="mt-2 flex items-center justify-between gap-3">
            <LanguagePicker value={language} onChange={setLanguage} />
            <button
              type="button"
              onClick={onNewConversation}
              disabled={isSending || !anonymousToken}
              className="inline-flex min-h-9 items-center justify-center rounded-full border border-current px-3 text-xs font-medium opacity-80 transition hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              New conversation
            </button>
          </div>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-2xl px-4 pt-3 sm:px-6">
          <LocationBanner
            permission={location.permission}
            onRefresh={location.refresh}
            show={venue.guideMode !== 'non_location'}
          />
        </div>
        <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col px-4 sm:px-6">
          <ChatWindow
            messages={messages}
            onSend={onSend}
            {...(onDraftChange ? { onDraftChange } : {})}
            {...(onRetry ? { onRetry } : {})}
            {...(retryLabel ? { retryLabel } : {})}
            isLoading={isSending}
            errorMessage={sendError}
            accentColor={palette.accent}
            accentContrastColor={palette.accentContrast}
            placeholder={LANGUAGE_PLACEHOLDERS[language] ?? 'Ask anything about this place...'}
            initialDraft={initialDraft}
            emptyState={
              <div lang={languagePresentation.code} dir={languagePresentation.direction}>
                <div className="mb-4 rounded-3xl border border-[var(--chat-border)] bg-[var(--chat-card)] p-6 shadow-sm">
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
                  onSend={onSend}
                />
              </div>
            }
            onPlaceCardView={onPlaceView}
            onPlaceCardClick={onPlaceClick}
            onDirectionsClick={onDirections}
          />
        </div>
      </main>
      <footer className="pb-[env(safe-area-inset-bottom,1rem)] pt-2 text-center">
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
      </footer>
    </div>
  )
}
