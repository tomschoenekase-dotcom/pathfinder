'use client'

import Link from 'next/link'
import type { CSSProperties } from 'react'
import type { PublicVenueMediaItem } from '@pathfinder/contracts'
import { parseChatAppearance, type ChatAppearance } from '@pathfinder/contracts/chat-appearance'
import { CHAT_FONT_OPTIONS, getChatPalette, resolveChatAppearance } from '@pathfinder/ui/theme'
import styles from './venue-arrival.module.css'

import { selectVenueMediaForPresentation } from '../lib/venue-media-presentation'
import { chatAppearanceStyle } from '../lib/chat-appearance-style'
import {
  VISITOR_TEXT_SCALE,
  resolveInterfaceLanguage,
  useHydrated,
  useVisitorPreferences,
} from '../lib/visitor-preferences'
import { VenueMediaShowcase } from './VenueMediaShowcase'
import { VenueBrandingImage } from './VenueBrandingImage'
import { VisitorSettings } from './VisitorSettings'
import { getVisitorUiCopy } from './visitor-ui-copy'

export type VenueArrivalSummary = {
  name: string
  description: string | null
  category: string | null
  chatTheme?: string | null
  chatAccentColor?: string | null
  chatFont?: string | null
  chatLogoUrl?: string | null
  chatBannerUrl?: string | null
  chatAppearance?: ChatAppearance | null
}

export function VenueArrival({
  venue,
  venueSlug,
  media,
  mediaStatus,
}: {
  venue: VenueArrivalSummary
  venueSlug: string
  media: PublicVenueMediaItem[]
  mediaStatus: 'ready' | 'unavailable'
}) {
  const presentedMedia = selectVenueMediaForPresentation(media)
  const hasMedia = presentedMedia.length > 0
  const [preferences, updatePreferences] = useVisitorPreferences()
  const hydrated = useHydrated()
  const language = resolveInterfaceLanguage(preferences.language, hydrated)
  const shellCopy = getVisitorUiCopy(language).shell

  const palette = getChatPalette(venue.chatTheme, venue.chatAccentColor)
  const appearance = parseChatAppearance(venue.chatAppearance)
  const bannerUrl = venue.chatBannerUrl ?? null
  // The start screen follows the chat: a chosen background fills the page behind protected
  // surfaces; otherwise a reviewed banner stays a decorative header treatment.
  const backdrop = appearance.background.mode === 'image' && bannerUrl && !preferences.highContrast
  const headerBanner =
    appearance.background.mode !== 'image' && bannerUrl && !preferences.highContrast
  const tokens = resolveChatAppearance(palette, appearance, {
    hasBackgroundImage: Boolean(backdrop),
    highContrast: preferences.highContrast,
  })
  const font =
    CHAT_FONT_OPTIONS.find((item) => item.value === venue.chatFont) ?? CHAT_FONT_OPTIONS[0]!
  const theme = {
    ...chatAppearanceStyle(palette, tokens, preferences.highContrast),
    '--arrival-bg': tokens.pageBg,
    '--arrival-text': tokens.pageText,
    '--arrival-muted': tokens.pageMuted,
    '--arrival-border': preferences.highContrast ? tokens.pageText : palette.border,
    '--arrival-accent': palette.accent,
    '--arrival-contrast': palette.accentContrast,
    '--arrival-surface': tokens.assistantBg,
    '--arrival-surface-text': tokens.assistantText,
    '--chat-text-scale': VISITOR_TEXT_SCALE[preferences.textSize],
    fontFamily: `var(${font.cssVar})`,
  } as CSSProperties
  const title = appearance.title ?? venue.name

  return (
    <main
      className={styles.page}
      style={theme}
      data-backdrop={backdrop ? 'image' : 'none'}
      data-contrast={preferences.highContrast ? 'high' : 'standard'}
    >
      {backdrop ? (
        <div className={styles.backdrop} aria-hidden="true">
          <VenueBrandingImage src={bannerUrl} className={styles.backdropImage!} />
          <span />
        </div>
      ) : null}
      <header className={styles.header} data-on-banner={headerBanner ? true : undefined}>
        {headerBanner ? (
          <>
            <VenueBrandingImage src={bannerUrl} className={styles.headerBanner!} />
            <span className={styles.headerShade} aria-hidden="true" />
          </>
        ) : null}
        <div className={styles.headerInner}>
          {venue.chatLogoUrl ? (
            <VenueBrandingImage src={venue.chatLogoUrl} className={styles.wordmark!} />
          ) : null}
          <h1 className={styles.title} lang="" dir="auto">
            {title}
          </h1>
        </div>
      </header>
      <div className={`${styles.layout} ${hasMedia ? styles.withMedia : ''}`}>
        <section className={styles.intro}>
          <p className={styles.eyebrow}>{venue.category || 'Your AI visitor guide'}</p>
          <p className={styles.description}>
            {venue.description ?? 'Ask your guide where to go, what to see, and what to do next.'}
          </p>
          <Link href={`/${venueSlug}/chat`} className={styles.action}>
            <span>Open your guide</span>
            <span className={styles.arrow} aria-hidden="true">
              →
            </span>
          </Link>
          <nav className={styles.entryQuestions} aria-label="Start with a question">
            <p>Or start with a question</p>
            {[
              'What should I see first?',
              'Help me plan my visit.',
              'What makes this place special?',
            ].map((prompt) => (
              <Link key={prompt} href={`/${venueSlug}/chat?prompt=${encodeURIComponent(prompt)}`}>
                <span>{prompt}</span>
                <span aria-hidden="true">→</span>
              </Link>
            ))}
          </nav>
          {mediaStatus === 'unavailable' ? (
            <p className={styles.notice} role="status">
              Venue photos are temporarily unavailable. Your guide is ready.
            </p>
          ) : null}
        </section>
        {hasMedia ? (
          <div className={styles.media}>
            <VenueMediaShowcase venueName={venue.name} items={presentedMedia} compact />
          </div>
        ) : null}
      </div>
      <footer className={styles.footer}>
        <VisitorSettings
          language={language}
          preferences={preferences}
          onPreferencesChange={updatePreferences}
          clearChatLabel={shellCopy[2]}
          aboutGuidance={shellCopy[12]}
          poweredByLabel={shellCopy[13]}
          attribution="link"
        />
      </footer>
    </main>
  )
}
